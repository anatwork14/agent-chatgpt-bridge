import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpAgentAdapter } from "./adapter";
import type { AcpAgentProfile } from "./profiles";

const input = {
  runId: "run_acp_test",
  objective: "Keep the test objective moving",
  round: 0,
};

function fakeAgentSource(): string {
  return String.raw`
    import * as acp from "@agentclientprotocol/sdk";
    import { Readable, Writable } from "node:stream";
    import { appendFileSync } from "node:fs";

    const mode = process.env.FAKE_ACP_MODE ?? "normal";
    const sessions = new Map();
    const cancelled = new Map();
    let clientCapabilities;
    const marker = process.env.FAKE_ACP_MARKER;
    const mark = (value) => marker && appendFileSync(marker, value + "\\n");

    const app = acp.agent({ name: "fake-acp-agent" })
      .onRequest(acp.methods.agent.initialize, (ctx) => {
        clientCapabilities = ctx.params.clientCapabilities;
        if (mode === "unsupported") return { protocolVersion: 999 };
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { sessionCapabilities: { close: {} } },
          agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
        };
      })
      .onRequest(acp.methods.agent.session.new, (ctx) => {
        const sessionId = "fake-session-" + String(sessions.size + 1);
        sessions.set(sessionId, { count: 0 });
        return { sessionId };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const session = sessions.get(ctx.params.sessionId);
        if (!session) throw new Error("missing fake session");
        session.count += 1;
        if (mode === "timeout") await new Promise(() => {});
        if (mode === "exit") process.exit(17);
        if (mode === "cancel") {
          await new Promise((resolve) => cancelled.set(ctx.params.sessionId, resolve));
          return { stopReason: "cancelled" };
        }
        if (mode === "permission") {
          const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: "permission-1", kind: "read", status: "pending", title: "Read a file" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject once", kind: "reject_once" },
            ],
          });
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "permission:" + (permission.outcome.outcome === "selected" ? permission.outcome.optionId : permission.outcome.outcome) },
            },
          });
          return { stopReason: "end_turn" };
        }
        const prompt = ctx.params.prompt.find((part) => part.type === "text")?.text ?? "";
        process.stderr.write("fake agent diagnostic\\n");
        const text = mode === "done"
          ? "<bridge_done>objective complete</bridge_done>"
          : "round=" + String(session.count) + "; env=" + (process.env.ACP_TEST_FORBIDDEN_SECRET ? "leaked" : "safe") + "; prompt=" + prompt;
        for (const chunk of [text.slice(0, 8), text.slice(8)]) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
          });
        }
        return { stopReason: "end_turn" };
      })
      .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
        mark("cancel-received");
        const resolve = cancelled.get(ctx.params.sessionId);
        if (resolve) resolve();
      })
      .onRequest(acp.methods.agent.session.close, (ctx) => {
        mark("session-close");
        sessions.delete(ctx.params.sessionId);
        return {};
      });

    app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  `;
}

function rawAgentSource(): string {
  return String.raw`
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdout.write("not-json\\n");
      setTimeout(() => process.exit(0), 10);
    });
  `;
}

function profile(mode = "normal", marker?: string): AcpAgentProfile {
  return {
    id: "fake",
    command: [process.execPath, "-e", fakeAgentSource()],
    authMode: "preauthenticated",
    options: {
      env: {
        FAKE_ACP_MODE: mode,
        ...(marker ? { FAKE_ACP_MARKER: marker } : {}),
      },
    },
  };
}

test("ACP adapter initializes once, reuses one session, reconstructs chunks, and maps explicit done", async () => {
  const adapter = new AcpAgentAdapter(profile("done"));
  try {
    await adapter.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    const first = await adapter.next(input, {});
    expect(first).toEqual({ type: "done", summary: "objective complete" });
  } finally {
    await adapter.close();
  }

  const continuity = new AcpAgentAdapter(profile());
  try {
    await continuity.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    const first = await continuity.next(input, {});
    const second = await continuity.next({ ...input, round: 1, lastChatGptResponse: { text: "ChatGPT latest" } }, {});
    expect(first.type).toBe("message");
    expect(second.type).toBe("message");
    if (first.type === "message" && second.type === "message") {
      expect(first.content).toContain("round=1");
      expect(second.content).toContain("round=2");
      expect(second.content).toContain("ChatGPT latest");
    }
  } finally {
    await continuity.close();
  }
});

test("ACP adapter fails closed for malformed and unsupported protocol responses", async () => {
  const malformed = new AcpAgentAdapter({
    id: "malformed",
    command: [process.execPath, "-e", rawAgentSource()],
    authMode: "preauthenticated",
  });
  await expect(malformed.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() }))
    .rejects.toMatchObject({ code: "agent_protocol_invalid" });
  await malformed.close();

  const bounded = new AcpAgentAdapter({
    id: "bounded",
    command: [process.execPath, "-e", rawAgentSource()],
    authMode: "preauthenticated",
  }, { maxProtocolBytes: 4 });
  await expect(bounded.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() }))
    .rejects.toMatchObject({ code: "agent_protocol_invalid" });
  await bounded.close();

  const unsupported = new AcpAgentAdapter(profile("unsupported"));
  await expect(unsupported.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() }))
    .rejects.toMatchObject({ code: "agent_protocol_invalid" });
  await unsupported.close();
});

test("ACP adapter maps an unexpected agent exit and keeps separate sessions isolated", async () => {
  const exited = new AcpAgentAdapter(profile("exit"));
  await exited.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
  await expect(exited.next(input, {})).rejects.toMatchObject({ code: "agent_adapter_failed" });
  await exited.close();

  const left = new AcpAgentAdapter(profile());
  const right = new AcpAgentAdapter(profile());
  try {
    await left.initialize({ runId: "run_left", objective: input.objective, cwd: process.cwd() });
    await right.initialize({ runId: "run_right", objective: input.objective, cwd: process.cwd() });
    const [leftResult, rightResult] = await Promise.all([
      left.next({ ...input, runId: "run_left" }, {}),
      right.next({ ...input, runId: "run_right" }, {}),
    ]);
    expect(leftResult.type).toBe("message");
    expect(rightResult.type).toBe("message");
    if (leftResult.type === "message" && rightResult.type === "message") {
      expect(leftResult.content).toContain("round=1");
      expect(rightResult.content).toContain("round=1");
    }
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test("ACP adapter sends session/cancel and cleans up a cancelled prompt", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "acp-cancel-")), "events.log");
  const adapter = new AcpAgentAdapter(profile("cancel", marker), { cancelGraceMs: 500 });
  try {
    await adapter.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    const controller = new AbortController();
    const pending = adapter.next(input, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "client_cancelled" });
    expect(readFileSync(marker, "utf8")).toContain("cancel-received");
  } finally {
    await adapter.close();
  }
});

test("ACP permission policy denies by default and allows read-only work explicitly", async () => {
  const denied = new AcpAgentAdapter(profile("permission"));
  try {
    await denied.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    expect(await denied.next(input, {})).toMatchObject({ type: "message", content: "permission:reject" });
  } finally {
    await denied.close();
  }

  const allowed = new AcpAgentAdapter(profile("permission"), { permissionMode: "allow_readonly" });
  try {
    await allowed.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    expect(await allowed.next(input, {})).toMatchObject({ type: "message", content: "permission:allow" });
  } finally {
    await allowed.close();
  }
});

test("ACP adapter enforces prompt timeout, protects its environment, and closes the session idempotently", async () => {
  const previous = process.env.ACP_TEST_FORBIDDEN_SECRET;
  process.env.ACP_TEST_FORBIDDEN_SECRET = "must-not-cross";
  try {
    const marker = join(mkdtempSync(join(tmpdir(), "acp-close-")), "events.log");
    const timeout = new AcpAgentAdapter(profile("timeout"), { timeoutMs: 30 });
    await timeout.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    await expect(timeout.next(input, {})).rejects.toMatchObject({ code: "agent_adapter_timeout" });
    await timeout.close();

    const normal = new AcpAgentAdapter(profile("normal", marker));
    await normal.initialize({ runId: input.runId, objective: input.objective, cwd: process.cwd() });
    const result = await normal.next(input, {});
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.content).toContain("round=1");
      expect(result.content).toContain("env=safe");
    }
    await normal.close();
    await normal.close();
    expect(existsSync(marker)).toBeTrue();
    expect(readFileSync(marker, "utf8")).toContain("session-close");
  } finally {
    if (previous === undefined) delete process.env.ACP_TEST_FORBIDDEN_SECRET;
    else process.env.ACP_TEST_FORBIDDEN_SECRET = previous;
  }
});
