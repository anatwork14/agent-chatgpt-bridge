import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const CONTROL_TOKEN = "live_smoke_test_control_token_0123456789abcdef";
const ROUTER_SECRET = "live-smoke-router-capability-secret";
const ROUTER_BASE_URL = `http://127.0.0.1:4202/_codex-router/${ROUTER_SECRET}/v1`;
const ROUTER_MODEL = "codex-router/test-provider/test-model";
const CHATGPT_MODEL = "chatgpt-web/high";

interface SessionState {
  id: string;
  provider: string;
  model: string;
  marker?: string;
  transcript: Array<{ role: string; content: Array<{ type: "text"; text: string }> }>;
}

function apiToken(): string {
  return createHash("sha256")
    .update("agent-chatgpt-bridge:v1:")
    .update(CONTROL_TOKEN)
    .digest("base64url");
}

function writeConfig(home: string): void {
  mkdirSync(join(home, "runtime"), { recursive: true });
  const brokerSocketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\agent-chatgpt-live-smoke-${process.pid}-${Date.now()}`
    : join(home, "runtime", "turn-broker.sock");
  const chromeExecutablePath = process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome";
  const config = {
    version: 3,
    releaseVersion: "live-smoke-test",
    mode: "browser-only",
    subagentProtocol: "native",
    host: "127.0.0.1",
    port: 1455,
    contextWindow: 128_000,
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    manualAppName: "Codex Zero Risk",
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    chromeExecutablePath,
    storageStatePath: join(home, "storage-state.json"),
    brokerSocketPath,
    headed: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: CONTROL_TOKEN,
    runtimeCommand: [process.execPath],
  };
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function runSmoke(home: string, port: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = resolve(import.meta.dir, "../../../scripts/smoke-live-bridge-codex-router.ts");
  const child = Bun.spawn([process.execPath, script], {
    env: {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: home,
      AGENT_CHATGPT_BRIDGE_PORT: String(port),
      AGENT_CHATGPT_CODEX_ROUTER_BASE_URL: ROUTER_BASE_URL,
      AGENT_CHATGPT_CODEX_ROUTER_SMOKE_MODEL: ROUTER_MODEL,
      AGENT_CHATGPT_CODEX_ROUTER_SMOKE_TIMEOUT_MS: "10000",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function authenticated(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${apiToken()}`;
}

test("live bridge codex-router smoke verifies routed continuity through public REST surfaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-chatgpt-live-smoke-script-"));
  writeConfig(home);
  const sessions = new Map<string, SessionState>();
  let nextSession = 1;

  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!authenticated(request)) return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === "/bridge/v1/healthz") {
        return Response.json({ status: "ok", service: "agent-chatgpt-bridge" });
      }
      if (url.pathname === "/bridge/v1/models") {
        return Response.json({ models: [CHATGPT_MODEL, ROUTER_MODEL] });
      }
      if (url.pathname === "/bridge/v1/sessions" && request.method === "POST") {
        const body = await request.json() as { model?: string };
        const id = `session_live_smoke_${nextSession++}`;
        const state: SessionState = {
          id,
          provider: "model-router",
          model: body.model || CHATGPT_MODEL,
          transcript: [],
        };
        sessions.set(id, state);
        return Response.json(state, { status: 201 });
      }

      const match = url.pathname.match(/^\/bridge\/v1\/sessions\/([^/]+)(\/messages|\/cancel)?$/);
      if (!match) return new Response("not found", { status: 404 });
      const id = decodeURIComponent(match[1]!);
      const suffix = match[2] || "";
      const session = sessions.get(id);
      if (!session) return Response.json({ error: { code: "session_not_found" } }, { status: 404 });

      if (!suffix && request.method === "GET") return Response.json(session);
      if (!suffix && request.method === "DELETE") {
        sessions.delete(id);
        return Response.json({ success: true });
      }
      if (suffix === "/messages" && request.method === "GET") {
        return Response.json(session.transcript);
      }
      if (suffix === "/messages" && request.method === "POST") {
        const body = await request.json() as { content?: Array<{ type?: string; text?: string }> };
        const prompt = body.content?.find(part => part.type === "text")?.text || "";
        session.transcript.push({ role: "user", content: [{ type: "text", text: prompt }] });
        const discovered = prompt.match(/BRIDGE_ROUTER_SMOKE_[A-Z0-9]+/)?.[0];
        if (discovered) session.marker = discovered;
        const text = session.marker || "bridge smoke acknowledgement";
        session.transcript.push({ role: "assistant", content: [{ type: "text", text }] });
        return Response.json({
          turn_id: `turn_${session.transcript.length}`,
          session_id: id,
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      }
      if (suffix === "/cancel" && request.method === "POST") {
        return Response.json({ success: true, cancelled: false });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const result = await runSmoke(home, bridge.port);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("LIVE_BRIDGE_CODEX_ROUTER_SMOKE_OK");
    expect(result.stdout).toContain(`model=${ROUTER_MODEL}`);
    expect(result.stdout).toContain("continuity=passed");
    expect(result.stdout).toContain("capability_leak=none");
    expect(result.stdout).not.toContain(ROUTER_SECRET);
    expect(sessions.size).toBe(0);
  } finally {
    bridge.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("live bridge smoke fails closed without printing capability material from a bridge error", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-chatgpt-live-smoke-redaction-"));
  writeConfig(home);

  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (!authenticated(request)) return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === "/bridge/v1/healthz") {
        return Response.json({ status: "ok", service: "agent-chatgpt-bridge" });
      }
      if (url.pathname === "/bridge/v1/models") {
        return Response.json({
          error: {
            code: "provider_unavailable",
            message: `router failure at ${ROUTER_BASE_URL}/models`,
          },
        }, { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const result = await runSmoke(home, bridge.port);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(ROUTER_SECRET);
    expect(result.stderr).not.toContain(ROUTER_SECRET);
    expect(result.stderr).toContain("Bridge response exposed codex-router capability URL material");
  } finally {
    bridge.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
