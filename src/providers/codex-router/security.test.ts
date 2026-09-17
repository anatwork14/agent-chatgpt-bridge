import { expect, test } from "bun:test";
import type { BridgeTurnRequest } from "../../core/domain";
import { CodexRouterConversationProvider } from "./provider";

const SECRET = "super-secret-caller-capability";
const BASE_URL = `http://127.0.0.1:4202/_codex-router/${SECRET}/v1`;

function request(): BridgeTurnRequest {
  return {
    requestId: "turn_secret_test",
    sessionId: "ses_secret_test",
    source: "internal",
    model: {
      provider: "codex-router",
      model: "codex-router/deepseek/deepseek-v4-pro",
    },
    messages: [{
      id: "msg_secret_test",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: true,
  };
}

test("model discovery never reflects a capability URL from transport errors", async () => {
  const fetchImpl = (async () => {
    throw new Error(`connect ECONNREFUSED ${BASE_URL}/models`);
  }) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({ baseUrl: BASE_URL, fetchImpl });

  let message = "";
  try {
    await provider.capabilities();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toBe("Could not reach Codex Router");
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain("_codex-router");
});

test("HTTP provider errors redact the caller capability path", async () => {
  const fetchImpl = (async () => Response.json({
    error: {
      code: "upstream_failure",
      message: `failed while serving ${BASE_URL}/responses`,
    },
  }, { status: 500 })) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({ baseUrl: BASE_URL, fetchImpl });

  const result = await provider.runTurn(request(), { emit: () => undefined });
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("provider_unavailable");
  expect(result.error?.message).toContain("[codex-router-endpoint]");
  expect(result.error?.message).not.toContain(SECRET);
  expect(result.error?.message).not.toContain("_codex-router");
});

test("SSE provider errors redact standalone capability paths", async () => {
  const secretPath = `/_codex-router/${SECRET}/v1`;
  const sse = [
    "event: error",
    `data: ${JSON.stringify({ type: "error", error: { code: "bad_route", message: `bad route ${secretPath}` } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const fetchImpl = (async () => new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({ baseUrl: BASE_URL, fetchImpl });

  const result = await provider.runTurn(request(), { emit: () => undefined });
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("bad_route");
  expect(result.error?.message).toContain("/[codex-router-capability]");
  expect(result.error?.message).not.toContain(SECRET);
  expect(result.error?.message).not.toContain("_codex-router");
});

test("raw non-BridgeError turn failures are normalized instead of reflected", async () => {
  const fetchImpl = (async () => {
    throw new Error(`socket error at ${BASE_URL}/responses`);
  }) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({ baseUrl: BASE_URL, fetchImpl });

  const result = await provider.runTurn(request(), { emit: () => undefined });
  expect(result.status).toBe("failed");
  expect(result.error).toEqual({
    code: "provider_exception",
    message: "Codex Router provider request failed",
    retryable: false,
  });
});
