import { expect, test } from "bun:test";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";
import type { ConversationProvider, ProviderCapabilities } from "./provider";
import {
  MODEL_ROUTER_PROVIDER_NAME,
  ModelRouterConversationProvider,
  ProviderRegistry,
} from "./registry";

class StubProvider implements ConversationProvider {
  constructor(
    public readonly name: string,
    private readonly models: string[],
    private readonly text = name,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: this.models };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    expect(request.model.provider).toBe(this.name);
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: this.text,
      providerMetadata: { concrete: this.name },
    };
  }
}

function request(model: string): BridgeTurnRequest {
  return {
    requestId: "turn_registry",
    sessionId: "ses_registry",
    source: "internal",
    model: { provider: MODEL_ROUTER_PROVIDER_NAME, model },
    messages: [{
      id: "msg_registry",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: false,
  };
}

test("provider registry lists a deduplicated namespaced catalog", async () => {
  const registry = new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high", "shared/model"]),
    new StubProvider("codex-router", ["codex-router/deepseek/v4", "shared/model"]),
  ]);

  expect(await registry.listModels()).toEqual([
    "chatgpt-web/high",
    "shared/model",
    "codex-router/deepseek/v4",
  ]);
});

test("model router delegates to exactly one concrete provider", async () => {
  const registry = new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high"], "chatgpt"),
    new StubProvider("codex-router", ["codex-router/deepseek/v4"], "deepseek"),
  ]);
  const router = new ModelRouterConversationProvider(registry);

  const result = await router.runTurn(request("codex-router/deepseek/v4"), { emit: () => undefined });
  expect(result.text).toBe("deepseek");
  expect(result.providerMetadata).toEqual({
    routedProvider: "codex-router",
    concrete: "codex-router",
  });
});

test("model router fails closed when no provider owns a model", async () => {
  const router = new ModelRouterConversationProvider(new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high"]),
  ]));
  expect(router.runTurn(request("unknown/model"), { emit: () => undefined }))
    .rejects.toThrow("No configured provider exposes model unknown/model");
});

test("model router rejects ambiguous model ownership", async () => {
  const router = new ModelRouterConversationProvider(new ProviderRegistry([
    new StubProvider("a", ["collision/model"]),
    new StubProvider("b", ["collision/model"]),
  ]));
  expect(router.runTurn(request("collision/model"), { emit: () => undefined }))
    .rejects.toThrow("ambiguous across providers");
});

test("provider registry reserves the model-router provider name", () => {
  expect(() => new ProviderRegistry([
    new StubProvider(MODEL_ROUTER_PROVIDER_NAME, ["x"]),
  ])).toThrow("reserved or invalid");
});
