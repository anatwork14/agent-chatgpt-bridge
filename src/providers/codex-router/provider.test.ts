import { expect, test } from "bun:test";
import type { BridgeEvent } from "../../core/events";
import type { BridgeTurnRequest } from "../../core/domain";
import { BridgeError } from "../../core/errors";
import {
  CODEX_ROUTER_PROVIDER_NAME,
  CodexRouterConversationProvider,
  codexRouterProviderOptionsFromEnv,
} from "./provider";

function request(overrides: Partial<BridgeTurnRequest> = {}): BridgeTurnRequest {
  return {
    requestId: "turn_test",
    sessionId: "ses_test",
    source: "internal",
    model: {
      provider: CODEX_ROUTER_PROVIDER_NAME,
      model: "codex-router/deepseek/deepseek-v4-pro",
      effort: "high",
    },
    messages: [{
      id: "msg_user",
      role: "user",
      content: [{ type: "text", text: "Hello router" }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: true,
    ...overrides,
  };
}

function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const text = frames
    .map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("Codex Router provider discovers namespaced models", async () => {
  let requestedUrl = "";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Response.json({
      object: "list",
      data: [
        { id: "deepseek/deepseek-v4-pro", object: "model" },
        { id: "anthropic-api/claude-opus-4.8", object: "model" },
      ],
    });
  }) as unknown as typeof fetch;

  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/caller-capability/v1/",
    fetchImpl,
  });
  const capabilities = await provider.capabilities();

  expect(requestedUrl).toBe("http://127.0.0.1:4202/caller-capability/v1/models");
  expect(capabilities.models).toEqual([
    "codex-router/deepseek/deepseek-v4-pro",
    "codex-router/anthropic-api/claude-opus-4.8",
  ]);
  expect(capabilities.supportsImages).toBe(false);
  expect(capabilities.supportsTools).toBe(false);
});

test("Codex Router provider translates Responses SSE into bridge events", async () => {
  let body: any;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([
      {
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "Hello " },
      },
      {
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "world" },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_router_1",
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      },
    ]);
  }) as unknown as typeof fetch;

  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/v1",
    fetchImpl,
  });
  const events: BridgeEvent[] = [];
  const result = await provider.runTurn(request(), { emit: event => events.push(event) });

  expect(body.model).toBe("deepseek/deepseek-v4-pro");
  expect(body.reasoning).toEqual({ effort: "high" });
  expect(body.stream).toBe(true);
  expect(body.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Hello router" }],
  });
  expect(result.status).toBe("completed");
  expect(result.text).toBe("Hello world");
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  expect(result.providerMetadata).toEqual({ responseId: "resp_router_1" });
  expect(events.map(event => event.type)).toEqual([
    "turn.started",
    "text.delta",
    "text.delta",
    "turn.completed",
  ]);
});

test("Codex Router provider preserves CRLF frame boundaries split across transport chunks", async () => {
  const delta = JSON.stringify({ type: "response.output_text.delta", delta: "chunk-safe" });
  const completed = JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_router_split_crlf",
      status: "completed",
      output: [],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  });
  const chunks = [
    "event: response.output_text.delta\r",
    `\ndata: ${delta}\r`,
    "\n\r",
    "\nevent: response.completed\r",
    `\ndata: ${completed}\r`,
    "\n\r",
    "\ndata: [DONE]\r",
    "\n\r",
    "\n",
  ];
  const fetchImpl = (async () => chunkedSseResponse(chunks)) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/v1",
    fetchImpl,
  });
  const events: BridgeEvent[] = [];

  const result = await provider.runTurn(request(), { emit: event => events.push(event) });

  expect(result.status).toBe("completed");
  expect(result.text).toBe("chunk-safe");
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  expect(result.providerMetadata).toEqual({ responseId: "resp_router_split_crlf" });
  expect(events.map(event => event.type)).toEqual([
    "turn.started",
    "text.delta",
    "turn.completed",
  ]);
});

test("Codex Router provider maps rate limits without silent fallback", async () => {
  const fetchImpl = (async () => Response.json({
    error: { code: "rate_limit_exceeded", message: "slow down" },
  }, { status: 429 })) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://localhost:4202/v1",
    fetchImpl,
  });

  const result = await provider.runTurn(request(), { emit: () => undefined });
  expect(result.status).toBe("failed");
  expect(result.error).toEqual({
    code: "provider_rate_limited",
    message: "slow down",
    retryable: true,
  });
});

test("Codex Router provider propagates cancellation into fetch", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/v1",
    fetchImpl,
  });

  const pending = provider.runTurn(request(), { signal: controller.signal, emit: () => undefined });
  controller.abort("test-cancel");
  const result = await pending;

  expect(receivedSignal).toBe(controller.signal);
  expect(result.status).toBe("cancelled");
  expect(result.error?.code).toBe("client_cancelled");
});

test("Codex Router provider rejects non-loopback base URLs by default", () => {
  expect(() => new CodexRouterConversationProvider({ baseUrl: "https://router.example.com/v1" }))
    .toThrow("must be loopback");
});

test("Codex Router provider environment integration is opt-in", () => {
  expect(codexRouterProviderOptionsFromEnv({})).toBeUndefined();
  expect(codexRouterProviderOptionsFromEnv({
    AGENT_CHATGPT_CODEX_ROUTER_BASE_URL: "http://127.0.0.1:4202/secret/v1",
    AGENT_CHATGPT_CODEX_ROUTER_API_KEY: "local-token",
  })).toEqual({
    baseUrl: "http://127.0.0.1:4202/secret/v1",
    apiKey: "local-token",
  });
});

test("Codex Router provider fails closed on unsupported images", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch should not run");
  }) as unknown as typeof fetch;
  const provider = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/v1",
    fetchImpl,
  });
  const result = await provider.runTurn(request({
    messages: [{
      id: "msg_image",
      role: "user",
      content: [{ type: "image", source: { type: "data_url", dataUrl: "data:image/png;base64,AA==" } }],
      createdAt: new Date(0).toISOString(),
    }],
  }), { emit: () => undefined });

  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("provider_capability_unsupported");
});
