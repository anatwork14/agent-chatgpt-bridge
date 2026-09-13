import { expect, test } from "bun:test";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";
import { BridgeError } from "../core/errors";
import type { ConversationProvider, ProviderCapabilities } from "./provider";
import { ModelRouterConversationProvider, ProviderRegistry } from "./registry";

class HealthProvider implements ConversationProvider {
  public turns = 0;

  constructor(
    public readonly name: string,
    private readonly models: string[],
    private readonly nextResult?: BridgeTurnResult,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: this.models };
  }

  async runTurn(request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    this.turns += 1;
    return this.nextResult ?? {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: "ok",
    };
  }
}

class OfflineProvider implements ConversationProvider {
  constructor(public readonly name: string) {}

  async capabilities(): Promise<ProviderCapabilities> {
    throw new BridgeError("provider_unavailable", "provider endpoint is offline", true);
  }

  async runTurn(): Promise<BridgeTurnResult> {
    throw new BridgeError("provider_unavailable", "provider endpoint is offline", true);
  }
}

function request(model: string): BridgeTurnRequest {
  return {
    requestId: "turn_health_registry",
    sessionId: "ses_health_registry",
    source: "internal",
    model: { provider: "model-router", model },
    messages: [{
      id: "msg_health_registry",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: new Date(0).toISOString(),
    }],
    stream: false,
  };
}

const ctx = { emit: (_event: BridgeEvent) => undefined };

test("registry records healthy and unavailable discovery independently", async () => {
  const registry = new ProviderRegistry([
    new HealthProvider("chatgpt-web", ["chatgpt-web/high"]),
    new OfflineProvider("codex-router"),
  ]);

  expect(await registry.listModels()).toEqual(["chatgpt-web/high"]);
  expect(registry.providerHealth().map(value => ({
    provider: value.provider,
    state: value.state,
    operation: value.operation,
    code: value.code,
  }))).toEqual([
    { provider: "chatgpt-web", state: "healthy", operation: "discovery", code: undefined },
    {
      provider: "codex-router",
      state: "unavailable",
      operation: "discovery",
      code: "provider_unavailable",
    },
  ]);
});

test("model-router records a downstream rate limit without falling back", async () => {
  const rateLimited: BridgeTurnResult = {
    requestId: "turn_health_registry",
    sessionId: "ses_health_registry",
    turnId: "turn_health_registry",
    status: "failed",
    text: "",
    error: {
      code: "provider_rate_limited",
      message: "downstream limit",
      retryable: true,
    },
  };
  const registry = new ProviderRegistry([
    new HealthProvider("chatgpt-web", ["chatgpt-web/high"]),
    new HealthProvider("codex-router", ["codex-router/deepseek/v4"], rateLimited),
  ]);
  const router = new ModelRouterConversationProvider(registry);

  const result = await router.runTurn(request("codex-router/deepseek/v4"), ctx);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("provider_rate_limited");
  expect(registry.providerHealth().find(value => value.provider === "codex-router")).toMatchObject({
    provider: "codex-router",
    state: "rate_limited",
    operation: "turn",
    code: "provider_rate_limited",
    retryable: true,
  });
  expect(registry.providerHealth().find(value => value.provider === "chatgpt-web")).toBeUndefined();
});

test("direct concrete-provider turns are observed too", async () => {
  const registry = new ProviderRegistry([
    new HealthProvider("codex-router", ["codex-router/deepseek/v4"]),
  ]);
  const provider = registry.get("codex-router")!;
  const routed = request("codex-router/deepseek/v4");

  const result = await provider.runTurn({
    ...routed,
    model: { ...routed.model, provider: "codex-router" },
  }, ctx);
  expect(result.status).toBe("completed");
  expect(registry.providerHealth()).toHaveLength(1);
  expect(registry.providerHealth()[0]).toMatchObject({
    provider: "codex-router",
    state: "healthy",
    operation: "turn",
  });
});

test("explicit cooldown changes only the named provider and blocks provider operations", async () => {
  const codexRouter = new HealthProvider("codex-router", ["codex-router/deepseek/v4"]);
  const registry = new ProviderRegistry([
    new HealthProvider("chatgpt-web", ["chatgpt-web/high"]),
    codexRouter,
  ]);
  await registry.listModels();

  const cooldownUntil = new Date(Date.now() + 60_000);
  registry.markProviderCooldown("codex-router", cooldownUntil);
  expect(registry.providerHealth().find(value => value.provider === "chatgpt-web")?.state).toBe("healthy");
  expect(registry.providerHealth().find(value => value.provider === "codex-router")).toMatchObject({
    state: "cooldown",
    operation: "policy",
    code: "provider_rate_limited",
    cooldownUntil: cooldownUntil.toISOString(),
  });

  await expect(registry.get("codex-router")!.runTurn(
    request("codex-router/deepseek/v4"),
    ctx,
  )).rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
  expect(codexRouter.turns).toBe(0);

  expect(() => registry.markProviderCooldown(
    "missing-provider",
    new Date(Date.now() + 60_000),
  )).toThrow("not registered");
});

test("configured rate-limit cooldown blocks the next concrete-provider call without extending itself", async () => {
  const rateLimited: BridgeTurnResult = {
    requestId: "turn_health_registry",
    sessionId: "ses_health_registry",
    turnId: "turn_health_registry",
    status: "failed",
    text: "",
    error: {
      code: "provider_rate_limited",
      message: "downstream limit",
      retryable: true,
    },
  };
  const codexRouter = new HealthProvider(
    "codex-router",
    ["codex-router/deepseek/v4"],
    rateLimited,
  );
  const registry = new ProviderRegistry([codexRouter], { rateLimitCooldownMs: 60_000 });
  const provider = registry.get("codex-router")!;

  const first = await provider.runTurn(request("codex-router/deepseek/v4"), ctx);
  expect(first.error?.code).toBe("provider_rate_limited");
  const cooldown = registry.providerHealth()[0]!;
  expect(cooldown).toMatchObject({
    provider: "codex-router",
    state: "cooldown",
    operation: "policy",
    code: "provider_rate_limited",
  });
  expect(cooldown.cooldownUntil).toBeDefined();
  expect(codexRouter.turns).toBe(1);

  await expect(provider.runTurn(request("codex-router/deepseek/v4"), ctx))
    .rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
  expect(codexRouter.turns).toBe(1);
  expect(registry.providerHealth()[0]?.cooldownUntil).toBe(cooldown.cooldownUntil);
});
