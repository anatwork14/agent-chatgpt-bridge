import { expect, test } from "bun:test";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";
import type { ConversationProvider, ProviderCapabilities } from "./provider";
import { ModelRouterConversationProvider, ProviderRegistry } from "./registry";
import type { ProviderRoutingPolicy } from "./policy";

class RoutedProvider implements ConversationProvider {
  public turns = 0;

  constructor(
    public readonly name: string,
    private readonly models: string[],
    private readonly reply: string,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: this.models };
  }

  async runTurn(request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    this.turns += 1;
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: this.reply,
      providerMetadata: { providerSawModel: request.model.model },
    };
  }
}

function request(model: string): BridgeTurnRequest {
  return {
    requestId: "turn_policy_registry",
    sessionId: "ses_policy_registry",
    source: "internal",
    model: { provider: "model-router", model },
    messages: [{
      id: "msg_policy_registry",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: false,
  };
}

function futureCooldown(): Date {
  return new Date(Date.now() + 60_000);
}

const ctx = { emit: (_event: BridgeEvent) => undefined };

test("default model-router never falls back from a provider in cooldown", async () => {
  const primary = new RoutedProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    "primary",
  );
  const fallback = new RoutedProvider("chatgpt-web", ["chatgpt-web/high"], "fallback");
  const registry = new ProviderRegistry([primary, fallback]);
  await registry.listModels();
  registry.markProviderCooldown("codex-router", futureCooldown());

  const router = new ModelRouterConversationProvider(registry);
  await expect(router.runTurn(request("codex-router/deepseek/v4"), ctx))
    .rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });

  expect(primary.turns).toBe(0);
  expect(fallback.turns).toBe(0);
});

test("explicit model-router policy may route a degraded provider to an ordered fallback", async () => {
  const primary = new RoutedProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    "primary",
  );
  const fallback = new RoutedProvider("chatgpt-web", ["chatgpt-web/high"], "fallback");
  const registry = new ProviderRegistry([primary, fallback]);
  await registry.listModels();
  registry.markProviderCooldown("codex-router", futureCooldown());

  const policy: ProviderRoutingPolicy = {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high"],
      on: ["cooldown"],
    },
  };
  const router = new ModelRouterConversationProvider(registry, policy);
  const result = await router.runTurn(request("codex-router/deepseek/v4"), ctx);

  expect(result.text).toBe("fallback");
  expect(primary.turns).toBe(0);
  expect(fallback.turns).toBe(1);
  expect(result.providerMetadata).toMatchObject({
    providerSawModel: "chatgpt-web/high",
    routedProvider: "chatgpt-web",
    routedModel: "chatgpt-web/high",
    requestedProvider: "codex-router",
    requestedModel: "codex-router/deepseek/v4",
    fallback: true,
    fallbackReasonState: "cooldown",
  });
});

test("explicit fallback skips a candidate already observed as degraded", async () => {
  const primary = new RoutedProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    "primary",
  );
  const first = new RoutedProvider("chatgpt-web", ["chatgpt-web/high"], "first");
  const second = new RoutedProvider("local", ["local/qwen"], "second");
  const registry = new ProviderRegistry([primary, first, second]);
  await registry.listModels();
  registry.markProviderCooldown("codex-router", futureCooldown());
  registry.markProviderCooldown("chatgpt-web", futureCooldown());

  const router = new ModelRouterConversationProvider(registry, {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high", "local/qwen"],
      on: ["cooldown"],
    },
  });
  const result = await router.runTurn(request("codex-router/deepseek/v4"), ctx);

  expect(result.text).toBe("second");
  expect(primary.turns).toBe(0);
  expect(first.turns).toBe(0);
  expect(second.turns).toBe(1);
  expect(result.providerMetadata).toMatchObject({
    routedProvider: "local",
    fallback: true,
    fallbackReasonState: "cooldown",
  });
});

test("explicit fallback rejects a namespaced model the provider does not actually expose", async () => {
  const primary = new RoutedProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    "primary",
  );
  const fallback = new RoutedProvider("chatgpt-web", ["chatgpt-web/high"], "fallback");
  const registry = new ProviderRegistry([primary, fallback]);
  await registry.listModels();
  registry.markProviderCooldown("codex-router", futureCooldown());

  const router = new ModelRouterConversationProvider(registry, {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/not-a-real-model"],
      on: ["cooldown"],
    },
  });

  await expect(router.runTurn(request("codex-router/deepseek/v4"), ctx))
    .rejects.toMatchObject({ code: "model_unavailable", retryable: false });
  expect(primary.turns).toBe(0);
  expect(fallback.turns).toBe(0);
});

test("model-router fails closed before provider execution when route audit cannot persist", async () => {
  const primary = new RoutedProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    "primary",
  );
  const registry = new ProviderRegistry([primary]);
  await registry.listModels();
  const router = new ModelRouterConversationProvider(
    registry,
    undefined,
    () => { throw new Error("audit store unavailable"); },
  );

  await expect(router.runTurn(request("codex-router/deepseek/v4"), ctx))
    .rejects.toThrow("audit store unavailable");
  expect(primary.turns).toBe(0);
});
