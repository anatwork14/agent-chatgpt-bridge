import { BridgeError } from "../core/errors";
import type { ProviderHealthObservation, ProviderHealthState } from "./health";
import type { ConversationProvider } from "./provider";

export type ProviderFallbackTrigger = Exclude<ProviderHealthState, "healthy">;

export type ProviderFallbackPolicy =
  | {
      mode: "disabled";
    }
  | {
      mode: "ordered";
      /** Public model ids to try in order. The requested model is never inserted implicitly. */
      models: readonly string[];
      /** Fallback is considered only when the requested provider currently has one of these states. */
      on: readonly ProviderFallbackTrigger[];
    };

export interface ProviderRoutingPolicy {
  fallback: ProviderFallbackPolicy;
}

export const DEFAULT_PROVIDER_ROUTING_POLICY: ProviderRoutingPolicy = Object.freeze({
  fallback: Object.freeze({ mode: "disabled" as const }),
});

export interface ProviderRouteDecision {
  requestedModel: string;
  requestedProvider: string;
  selectedModel: string;
  selectedProvider: string;
  fallback: boolean;
  reasonState?: ProviderFallbackTrigger;
}

function currentState(
  health: readonly ProviderHealthObservation[],
  provider: string,
): ProviderHealthState | undefined {
  return health.find(observation => observation.provider === provider)?.state;
}

function degraded(state: ProviderHealthState | undefined): boolean {
  return state !== undefined && state !== "healthy";
}

function validateOrderedPolicy(policy: Extract<ProviderFallbackPolicy, { mode: "ordered" }>): void {
  if (policy.models.length === 0) {
    throw new BridgeError(
      "invalid_request",
      "Ordered provider fallback policy requires at least one fallback model",
      false,
    );
  }
  if (policy.on.length === 0) {
    throw new BridgeError(
      "invalid_request",
      "Ordered provider fallback policy requires at least one trigger state",
      false,
    );
  }
  if (new Set(policy.models).size !== policy.models.length) {
    throw new BridgeError("invalid_request", "Provider fallback model order contains duplicates", false);
  }
  if (new Set(policy.on).size !== policy.on.length) {
    throw new BridgeError("invalid_request", "Provider fallback trigger states contain duplicates", false);
  }
}

function retryableCandidateResolutionFailure(error: unknown): boolean {
  return error instanceof BridgeError && error.retryable === true;
}

/**
 * Selects a route only from explicit policy plus bridge-level health observations.
 *
 * Important: this function never invents fallback. With the default policy it returns the
 * requested route even when that provider is known degraded. This keeps failure semantics visible
 * and prevents a session from silently migrating models/providers.
 */
export async function selectProviderRoute(
  requestedModel: string,
  requestedProvider: ConversationProvider,
  health: readonly ProviderHealthObservation[],
  resolveModel: (model: string) => Promise<ConversationProvider>,
  policy: ProviderRoutingPolicy = DEFAULT_PROVIDER_ROUTING_POLICY,
): Promise<ProviderRouteDecision> {
  const primary: ProviderRouteDecision = {
    requestedModel,
    requestedProvider: requestedProvider.name,
    selectedModel: requestedModel,
    selectedProvider: requestedProvider.name,
    fallback: false,
  };

  if (policy.fallback.mode === "disabled") return primary;
  validateOrderedPolicy(policy.fallback);

  const state = currentState(health, requestedProvider.name);
  if (!state || state === "healthy" || !policy.fallback.on.includes(state)) return primary;

  for (const model of policy.fallback.models) {
    if (model === requestedModel) continue;

    let provider: ConversationProvider;
    try {
      provider = await resolveModel(model);
    } catch (error) {
      // Ordered policy may move past a transiently unavailable candidate. Configuration and
      // ambiguity errors remain hard failures so a typo or unsafe route is never silently hidden.
      if (retryableCandidateResolutionFailure(error)) continue;
      throw error;
    }

    const candidateState = currentState(health, provider.name);
    if (degraded(candidateState)) continue;
    return {
      requestedModel,
      requestedProvider: requestedProvider.name,
      selectedModel: model,
      selectedProvider: provider.name,
      fallback: true,
      reasonState: state,
    };
  }

  throw new BridgeError(
    "provider_unavailable",
    `Provider ${requestedProvider.name} is ${state} and no explicitly configured fallback route is eligible`,
    true,
  );
}
