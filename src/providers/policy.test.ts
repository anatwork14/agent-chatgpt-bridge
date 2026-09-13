import { expect, test } from "bun:test";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { ConversationProvider, ProviderCapabilities } from "./provider";
import type { ProviderHealthObservation } from "./health";
import {
  DEFAULT_PROVIDER_ROUTING_POLICY,
  selectProviderRoute,
  type ProviderRoutingPolicy,
} from "./policy";

class PolicyProvider implements ConversationProvider {
  constructor(public readonly name: string, private readonly model: string) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: [this.model] };
  }

  async runTurn(request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: "ok",
    };
  }
}

function observation(provider: string, state: ProviderHealthObservation["state"]): ProviderHealthObservation {
  return {
    provider,
    state,
    operation: "turn",
    observedAt: "2026-09-13T00:00:00.000Z",
  };
}

const chatgpt = new PolicyProvider("chatgpt-web", "chatgpt-web/high");
const router = new PolicyProvider("codex-router", "codex-router/deepseek/v4");
const local = new PolicyProvider("local", "local/qwen");
const providers = new Map([
  ["chatgpt-web/high", chatgpt],
  ["codex-router/deepseek/v4", router],
  ["local/qwen", local],
]);
const resolveModel = async (model: string): Promise<ConversationProvider> => {
  const provider = providers.get(model);
  if (!provider) throw new Error(`unknown model ${model}`);
  return provider;
};

test("default routing policy never falls back even when provider is degraded", async () => {
  const decision = await selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "rate_limited")],
    resolveModel,
    DEFAULT_PROVIDER_ROUTING_POLICY,
  );

  expect(decision).toEqual({
    requestedModel: "codex-router/deepseek/v4",
    requestedProvider: "codex-router",
    selectedModel: "codex-router/deepseek/v4",
    selectedProvider: "codex-router",
    fallback: false,
  });
});

test("ordered fallback is used only for an explicitly configured trigger", async () => {
  const policy: ProviderRoutingPolicy = {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high", "local/qwen"],
      on: ["rate_limited", "cooldown"],
    },
  };

  const decision = await selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "rate_limited")],
    resolveModel,
    policy,
  );

  expect(decision).toEqual({
    requestedModel: "codex-router/deepseek/v4",
    requestedProvider: "codex-router",
    selectedModel: "chatgpt-web/high",
    selectedProvider: "chatgpt-web",
    fallback: true,
    reasonState: "rate_limited",
  });
});

test("ordered fallback does not activate for an unlisted state or healthy provider", async () => {
  const policy: ProviderRoutingPolicy = {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high"],
      on: ["rate_limited"],
    },
  };

  const unavailable = await selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "unavailable")],
    resolveModel,
    policy,
  );
  expect(unavailable.fallback).toBe(false);

  const healthy = await selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "healthy")],
    resolveModel,
    policy,
  );
  expect(healthy.fallback).toBe(false);
});

test("ordered fallback skips candidates already known degraded", async () => {
  const policy: ProviderRoutingPolicy = {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high", "local/qwen"],
      on: ["cooldown"],
    },
  };

  const decision = await selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [
      observation("codex-router", "cooldown"),
      observation("chatgpt-web", "unavailable"),
      observation("local", "healthy"),
    ],
    resolveModel,
    policy,
  );
  expect(decision.selectedModel).toBe("local/qwen");
  expect(decision.selectedProvider).toBe("local");
  expect(decision.fallback).toBe(true);
});

test("ordered fallback fails closed when no configured route is eligible", async () => {
  const policy: ProviderRoutingPolicy = {
    fallback: {
      mode: "ordered",
      models: ["chatgpt-web/high"],
      on: ["unavailable"],
    },
  };

  await expect(selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [
      observation("codex-router", "unavailable"),
      observation("chatgpt-web", "misconfigured"),
    ],
    resolveModel,
    policy,
  )).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
});

test("ordered fallback policy rejects empty or ambiguous configuration", async () => {
  await expect(selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "rate_limited")],
    resolveModel,
    { fallback: { mode: "ordered", models: [], on: ["rate_limited"] } },
  )).rejects.toMatchObject({ code: "invalid_request" });

  await expect(selectProviderRoute(
    "codex-router/deepseek/v4",
    router,
    [observation("codex-router", "rate_limited")],
    resolveModel,
    {
      fallback: {
        mode: "ordered",
        models: ["chatgpt-web/high", "chatgpt-web/high"],
        on: ["rate_limited"],
      },
    },
  )).rejects.toMatchObject({ code: "invalid_request" });
});
