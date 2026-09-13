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

class FailingProvider implements ConversationProvider {
  constructor(public readonly name: string, private readonly message = `${name} unavailable`) {}

  async capabilities(): Promise<ProviderCapabilities> {
    throw new Error(this.message);
  }

  async runTurn(): Promise<BridgeTurnResult> {
    throw new Error(this.message);
  }
}

class CancelableProvider implements ConversationProvider {
  public readonly name = "chatgpt-web";
  public readonly cancellations: string[] = [];
  public release!: () => void;

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: ["chatgpt-web/high"] };
  }

  async runTurn(
    request: BridgeTurnRequest,
    _ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    await new Promise<void>(resolve => { this.release = resolve; });
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: "released",
    };
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    this.cancellations.push(`${sessionId}:${turnId}`);
    this.release();
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

test("provider discovery isolates degraded optional providers", async () => {
  const registry = new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high"]),
    new FailingProvider("codex-router", "router offline"),
  ]);
  expect(await registry.listModels()).toEqual(["chatgpt-web/high"]);
  await expect(registry.listModels({ strict: true })).rejects.toThrow("router offline");
});

test("targeted model validation does not touch an unrelated degraded provider", async () => {
  const registry = new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high"]),
    new FailingProvider("codex-router", "router offline"),
  ]);
  await expect(registry.validateModel("chatgpt-web/high")).resolves.toBeUndefined();
});

test("targeted model validation surfaces failure from the selected provider", async () => {
  const registry = new ProviderRegistry([
    new StubProvider("chatgpt-web", ["chatgpt-web/high"]),
    new FailingProvider("codex-router", "router offline"),
  ]);
  await expect(registry.validateModel("codex-router/deepseek/v4")).rejects.toThrow("router offline");
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
    concrete: "codex-router",
    routedProvider: "codex-router",
    routedModel: "codex-router/deepseek/v4",
    requestedProvider: "codex-router",
    requestedModel: "codex-router/deepseek/v4",
    fallback: false,
  });
});

test("model router delegates cancellation to the concrete active provider", async () => {
  const provider = new CancelableProvider();
  const router = new ModelRouterConversationProvider(new ProviderRegistry([provider]));
  const pending = router.runTurn(request("chatgpt-web/high"), { emit: () => undefined });
  for (let attempt = 0; attempt < 20 && !provider.release; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  await router.cancelTurn("ses_registry", "turn_registry");
  await expect(pending).resolves.toMatchObject({ status: "completed" });
  expect(provider.cancellations).toEqual(["ses_registry:turn_registry"]);
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
