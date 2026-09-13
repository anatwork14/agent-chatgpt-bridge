import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";
import { BridgeError } from "../core/errors";
import type { ConversationProvider, ProviderCapabilities } from "./provider";
import {
  ProviderHealthTracker,
  type ProviderHealthObservation,
  type ProviderHealthTrackerOptions,
} from "./health";
import {
  DEFAULT_PROVIDER_ROUTING_POLICY,
  selectProviderRoute,
  type ProviderRouteDecision,
  type ProviderRoutingPolicy,
} from "./policy";

export const MODEL_ROUTER_PROVIDER_NAME = "model-router";

export type ProviderRouteDecisionObserver = (
  decision: ProviderRouteDecision,
  request: BridgeTurnRequest,
) => void | Promise<void>;

export interface ProviderRegistryOptions extends ProviderHealthTrackerOptions {}

function assertProviderNotCoolingDown(
  providerName: string,
  health: ProviderHealthTracker,
): void {
  const observation = health.get(providerName);
  if (observation?.state !== "cooldown") return;
  const suffix = observation.cooldownUntil ? ` until ${observation.cooldownUntil}` : "";
  throw new BridgeError(
    "provider_rate_limited",
    `Provider ${providerName} is in cooldown${suffix}`,
    true,
  );
}

function observedProvider(
  delegate: ConversationProvider,
  health: ProviderHealthTracker,
): ConversationProvider {
  const provider: ConversationProvider = {
    name: delegate.name,

    async capabilities(): Promise<ProviderCapabilities> {
      assertProviderNotCoolingDown(delegate.name, health);
      try {
        const capabilities = await delegate.capabilities();
        health.recordSuccess(delegate.name, "discovery");
        return capabilities;
      } catch (error) {
        health.recordError(delegate.name, error, "discovery");
        throw error;
      }
    },

    async runTurn(
      request: BridgeTurnRequest,
      ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
    ): Promise<BridgeTurnResult> {
      assertProviderNotCoolingDown(delegate.name, health);
      try {
        const result = await delegate.runTurn(request, ctx);
        health.recordTurn(delegate.name, result);
        return result;
      } catch (error) {
        health.recordError(delegate.name, error, "turn");
        throw error;
      }
    },
  };

  if (delegate.validateModel) {
    provider.validateModel = async (model: string): Promise<void> => {
      assertProviderNotCoolingDown(delegate.name, health);
      try {
        await delegate.validateModel!(model);
        health.recordSuccess(delegate.name, "validation");
      } catch (error) {
        health.recordError(delegate.name, error, "validation");
        throw error;
      }
    };
  }

  if (delegate.cancelTurn) {
    provider.cancelTurn = (sessionId: string, turnId: string): Promise<void> => (
      delegate.cancelTurn!(sessionId, turnId)
    );
  }

  if (delegate.closeSession) {
    provider.closeSession = (sessionId: string): Promise<void> => delegate.closeSession!(sessionId);
  }

  return provider;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ConversationProvider>();
  private readonly health: ProviderHealthTracker;

  constructor(
    initial: readonly ConversationProvider[] = [],
    options: ProviderRegistryOptions = {},
  ) {
    this.health = new ProviderHealthTracker(() => new Date(), options);
    for (const provider of initial) this.register(provider);
  }

  register(provider: ConversationProvider): void {
    if (!provider.name || provider.name === MODEL_ROUTER_PROVIDER_NAME) {
      throw new BridgeError(
        "invalid_request",
        `Provider name ${JSON.stringify(provider.name)} is reserved or invalid`,
        false,
      );
    }
    if (this.providers.has(provider.name)) {
      throw new BridgeError("session_conflict", `Provider ${provider.name} is already registered`, false);
    }
    this.providers.set(provider.name, observedProvider(provider, this.health));
  }

  get(name: string): ConversationProvider | undefined {
    return this.providers.get(name);
  }

  values(): ConversationProvider[] {
    return [...this.providers.values()];
  }

  asRecord(extra: readonly ConversationProvider[] = []): Record<string, ConversationProvider> {
    const entries = this.values().map(provider => [provider.name, provider] as const);
    for (const provider of extra) entries.push([provider.name, provider] as const);
    return Object.fromEntries(entries);
  }

  providerHealth(): ProviderHealthObservation[] {
    return this.health.list(this.values().map(provider => provider.name));
  }

  markProviderCooldown(
    providerName: string,
    cooldownUntil: Date,
    code = "provider_rate_limited",
  ): ProviderHealthObservation {
    if (!this.providers.has(providerName)) {
      throw new BridgeError("invalid_request", `Provider ${providerName} is not registered`, false);
    }
    if (!Number.isFinite(cooldownUntil.getTime())) {
      throw new BridgeError("invalid_request", "Provider cooldown deadline must be a valid date", false);
    }
    return this.health.markCooldown(providerName, cooldownUntil, code);
  }

  private namespacedOwner(model: string): ConversationProvider | undefined {
    const matches = this.values().filter(provider => model.startsWith(`${provider.name}/`));
    if (matches.length > 1) {
      throw new BridgeError(
        "session_conflict",
        `Model ${model} is ambiguous across provider namespaces: ${matches.map(provider => provider.name).join(", ")}`,
        false,
      );
    }
    return matches[0];
  }

  /**
   * Discovery is intentionally best-effort by default: an optional degraded provider must not
   * make unrelated provider catalogs disappear. Use strict=true only for diagnostics/tests that
   * explicitly require every configured provider to answer.
   */
  async listModels({ strict = false }: { strict?: boolean } = {}): Promise<string[]> {
    const discovered = await Promise.allSettled(this.values().map(provider => provider.capabilities()));
    if (strict) {
      const rejected = discovered.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    }
    const models = discovered.flatMap(result => result.status === "fulfilled" ? result.value.models : []);
    return [...new Set(models)];
  }

  /** Validate only the provider that owns a namespaced model. */
  async validateModel(model: string): Promise<void> {
    const owner = this.namespacedOwner(model);
    if (owner) {
      if (owner.validateModel) {
        await owner.validateModel(model);
        return;
      }
      const capabilities = await owner.capabilities();
      if (!capabilities.models.includes(model)) {
        throw new BridgeError(
          "model_unavailable",
          `Provider ${owner.name} does not expose model ${model}`,
          false,
        );
      }
      return;
    }

    // Compatibility path for legacy, non-namespaced model ids.
    const matches: ConversationProvider[] = [];
    for (const provider of this.values()) {
      const capabilities = await provider.capabilities();
      if (capabilities.models.includes(model)) matches.push(provider);
    }
    if (matches.length === 0) {
      throw new BridgeError("model_unavailable", `No configured provider exposes model ${model}`, false);
    }
    if (matches.length > 1) {
      throw new BridgeError(
        "session_conflict",
        `Model ${model} is ambiguous across providers: ${matches.map(provider => provider.name).join(", ")}`,
        false,
      );
    }
  }

  async resolveModel(model: string): Promise<ConversationProvider> {
    // Public provider namespaces are the fast, deterministic ownership path. This avoids a network
    // model-catalog request before every turn for downstream providers such as codex-router.
    const namespaced = this.namespacedOwner(model);
    if (namespaced) return namespaced;

    // Compatibility path for existing or injected providers whose public model ids predate the
    // namespace rule. Ambiguous ownership remains a hard failure instead of a first-match fallback.
    const capabilityMatches: ConversationProvider[] = [];
    for (const provider of this.values()) {
      const capabilities = await provider.capabilities();
      if (capabilities.models.includes(model)) capabilityMatches.push(provider);
    }
    if (capabilityMatches.length === 0) {
      throw new BridgeError("model_unavailable", `No configured provider exposes model ${model}`, false);
    }
    if (capabilityMatches.length > 1) {
      throw new BridgeError(
        "session_conflict",
        `Model ${model} is ambiguous across providers: ${capabilityMatches.map(provider => provider.name).join(", ")}`,
        false,
      );
    }
    return capabilityMatches[0]!;
  }
}

export class ModelRouterConversationProvider implements ConversationProvider {
  public readonly name = MODEL_ROUTER_PROVIDER_NAME;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly policy: ProviderRoutingPolicy = DEFAULT_PROVIDER_ROUTING_POLICY,
    private readonly onRouteDecision?: ProviderRouteDecisionObserver,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      // These capabilities are model-specific. The meta-provider stays conservative and delegates
      // exact capability enforcement to the selected concrete provider.
      supportsImages: false,
      supportsTools: false,
      models: await this.registry.listModels(),
    };
  }

  async validateModel(model: string): Promise<void> {
    await this.registry.validateModel(model);
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    const requestedProvider = await this.registry.resolveModel(request.model.model);
    const decision = await selectProviderRoute(
      request.model.model,
      requestedProvider,
      this.registry.providerHealth(),
      model => this.registry.resolveModel(model),
      this.policy,
    );
    const provider = decision.fallback
      ? this.registry.get(decision.selectedProvider)
      : requestedProvider;
    if (!provider) {
      throw new BridgeError(
        "provider_unavailable",
        `Selected provider ${decision.selectedProvider} is no longer registered`,
        true,
      );
    }

    // The bridge records its routing decision before provider execution. If an injected observer
    // cannot persist that decision, fail closed instead of creating an unaudited provider turn.
    await this.onRouteDecision?.(decision, request);

    const result = await provider.runTurn({
      ...request,
      model: {
        ...request.model,
        provider: provider.name,
        model: decision.selectedModel,
      },
    }, ctx);
    return {
      ...result,
      providerMetadata: {
        ...(result.providerMetadata ?? {}),
        routedProvider: provider.name,
        routedModel: decision.selectedModel,
        requestedProvider: decision.requestedProvider,
        requestedModel: decision.requestedModel,
        fallback: decision.fallback,
        ...(decision.reasonState ? { fallbackReasonState: decision.reasonState } : {}),
      },
    };
  }
}
