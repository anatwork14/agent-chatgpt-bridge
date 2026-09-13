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
  registry.markProviderCooldown("codex-router", new Date("2026-09-13T00:10:00.000Z"));

  const router = new ModelRouterConversationProvider(registry);
  const result = await router.runTurn(request("codex-router/deepseek/v4"), ctx);

  expect(result.text).toBe("primary");
  expect(primary.turns).toBe(1);
  expect(fallback.turns).toBe(0);
  expect(result.providerMetadata).toMatchObject({
    routedProvider: "codex-router",
    routedModel: "codex-router/deepseek/v4",
    requestedProvider: "codex-router",
    requestedModel: "codex-router/deepseek/v4",
    fallback: false,
  });
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
  registry.markProviderCooldown("codex-router", new Date("2026-09-13T00:10:00.000Z"));

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
  registry.markProviderCooldown("codex-router", new Date("2026-09-13T00:10:00.000Z"));
  registry.markProviderCooldown("chatgpt-web", new Date("2026-09-13T00:10:00.000Z"));

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
