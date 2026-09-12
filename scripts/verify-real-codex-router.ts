import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexRouterConversationProvider } from "../src/providers/codex-router/provider";

const CALLER_KEY = "bridge_ci_caller_capability_0123456789abcdef";
const INTERNAL_KEY = "bridge_ci_internal_capability_0123456789abcdef";
// This is the pinned router's current direct DeepSeek Responses route and is covered by
// codex-router's own deepseek-responses-routing.test.mjs fixture.
const ROUTED_MODEL = "codex-router/deepseek/deepseek-v4.1-flash";
// This focused fixture points the router's API plane directly at the fake upstream, bypassing the
// api-forwarder that would normally translate gatewayModel -> upstreamModel for the provider.
const UPSTREAM_MODEL = "deepseek-v4-1-flash";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback router port"));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function redact(value: string): string {
  return value
    .split(CALLER_KEY).join("[REDACTED_CALLER_CAPABILITY]")
    .split(INTERNAL_KEY).join("[REDACTED_INTERNAL_CAPABILITY]")
    .split("bridge-ci-local-test-key").join("[REDACTED_TEST_KEY]");
}

async function stopChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const settled = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!settled && child.exitCode === null) child.kill("SIGKILL");
  await child.exited.catch(() => undefined);
}

async function waitForRouter(baseUrl: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`codex-router exited before readiness with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/models`);
      if (response.ok) return;
    } catch {
      // Listener has not bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("codex-router did not expose /models before the readiness timeout");
}

const routerRepo = process.env.CODEX_ROUTER_REPO_DIR?.trim();
invariant(routerRepo, "CODEX_ROUTER_REPO_DIR must point at a pinned codex-router checkout");
const routerEntry = resolve(routerRepo, "src", "router.mjs");
invariant(existsSync(routerEntry), `Pinned codex-router entrypoint is missing: ${routerEntry}`);
const fixtureCatalog = resolve(routerRepo, "config", "deepseek", "deepseek-v4.1-flash.json");
invariant(existsSync(fixtureCatalog), `Pinned codex-router fixture catalog is missing: ${fixtureCatalog}`);

const nodeBinary = process.env.CODEX_ROUTER_NODE?.trim() || Bun.which("node");
invariant(nodeBinary, "Node.js is required to launch the real codex-router fixture");

const stateDir = mkdtempSync(join(tmpdir(), "agent-chatgpt-real-router-state-"));
// Keep explicit provider policy on disk just like a real installation. The environment key below
// mirrors codex-router's own direct DeepSeek routing fixture and prevents platform/keychain
// discovery from affecting CI.
writeFileSync(
  join(stateDir, "enabled-providers.json"),
  `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
  { mode: 0o600 },
);

const upstreamBodies: any[] = [];
const upstreamPaths: string[] = [];

const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && (url.pathname === "/responses" || url.pathname === "/v1/responses")) {
      const body = await request.json() as any;
      upstreamBodies.push(body);
      upstreamPaths.push(url.pathname);
      const text = "real codex-router integration ok";
      const responseId = `resp_real_router_${upstreamBodies.length}`;
      const messageId = `msg_real_router_${upstreamBodies.length}`;
      const frames = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: responseId, status: "in_progress", output: [] },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.output_text.done",
          sequence_number: 2,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: responseId,
            object: "response",
            status: "completed",
            output: [{
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            }],
            usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
          },
        },
      ];
      const stream = frames
        .map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
        .join("") + "data: [DONE]\n\n";
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const routerPort = await availablePort();
const baseUrl = `http://127.0.0.1:${routerPort}/_codex-router/${CALLER_KEY}/v1`;
const child = Bun.spawn([nodeBinary, routerEntry], {
  cwd: routerRepo,
  env: {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    KIMI_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_PORT: String(routerPort),
    // Production installs point this at merged-models.json. The integration fixture instead uses
    // the pinned router's own checked-in model descriptor so catalog discovery is deterministic
    // without requiring a native Codex installation/capture step on GitHub Actions.
    CODEX_ROUTER_CATALOG: fixtureCatalog,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    // Direct API providers (including DeepSeek) are sent to the router's API plane. In a full
    // installation that plane is the api-forwarder on port 4203; this focused integration fixture
    // deliberately substitutes the same in-process fake upstream instead of spawning another service.
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${gateway.port}`,
    DEEPSEEK_API_KEY: "bridge-ci-local-test-key",
  },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "pipe",
});
const stderrPromise = new Response(child.stderr).text();
let failure: unknown;

try {
  await waitForRouter(baseUrl, child);

  const provider = new CodexRouterConversationProvider({ baseUrl });
  const capabilities = await provider.capabilities();
  invariant(
    capabilities.models.includes(ROUTED_MODEL),
    `Pinned codex-router did not expose required fixture model ${ROUTED_MODEL}; exposed=${capabilities.models.slice(0, 20).join(",")}`,
  );

  const events: string[] = [];
  const result = await provider.runTurn({
    requestId: "turn_real_codex_router_ci",
    sessionId: "session_real_codex_router_ci",
    source: "internal",
    model: { provider: provider.name, model: ROUTED_MODEL, effort: "high" },
    messages: [{
      id: "msg_real_codex_router_ci",
      role: "user",
      content: [{ type: "text", text: "Verify the real codex-router transport boundary." }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: true,
  }, {
    emit(event) {
      events.push(event.type);
    },
  });

  invariant(result.status === "completed", `Real codex-router turn ended as ${result.status}: ${result.error?.code ?? "no-error-code"}`);
  invariant(result.text === "real codex-router integration ok", `Unexpected routed text: ${result.text}`);
  invariant(result.usage?.totalTokens === 11, "Real codex-router usage did not propagate");
  invariant(events.includes("text.delta"), "Real codex-router stream emitted no text.delta event");
  invariant(events.at(-1) === "turn.completed", "Real codex-router stream emitted no terminal completion");
  invariant(upstreamBodies.length === 1, `Expected one upstream turn, received ${upstreamBodies.length}`);
  invariant(
    upstreamPaths[0] === "/responses" || upstreamPaths[0] === "/v1/responses",
    `Unexpected codex-router upstream path: ${upstreamPaths[0]}`,
  );
  invariant(
    upstreamBodies[0]?.model === UPSTREAM_MODEL,
    `Unexpected upstream model: ${String(upstreamBodies[0]?.model)}`,
  );

  process.stdout.write(`REAL_CODEX_ROUTER_INTEGRATION_OK model=${ROUTED_MODEL}\n`);
} catch (error) {
  failure = error;
} finally {
  await stopChild(child);
  gateway.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
}

const stderr = redact(await stderrPromise);
if (failure) {
  const reason = failure instanceof Error ? failure.message : String(failure);
  const diagnostic = stderr.trim() ? `\ncodex-router stderr:\n${stderr.slice(-4_000)}` : "";
  throw new Error(`${reason}${diagnostic}`);
}
