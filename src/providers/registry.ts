import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";
import { BridgeError } from "../core/errors";
import type { ConversationProvider, ProviderCapabilities } from "./provider";

export const MODEL_ROUTER_PROVIDER_NAME = "model-router";

export class ProviderRegistry {
  private readonly providers = new Map<string, ConversationProvider>();

  constructor(initial: readonly ConversationProvider[] = []) {
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
    this.providers.set(provider.name, provider);
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

  async listModels(): Promise<string[]> {
    const discovered = await Promise.all(this.values().map(async provider => {
      const capabilities = await provider.capabilities();
      return capabilities.models;
    }));
    return [...new Set(discovered.flat())];
  }

  async resolveModel(model: string): Promise<ConversationProvider> {
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
    return matches[0]!;
  }
}

export class ModelRouterConversationProvider implements ConversationProvider {
  public readonly name = MODEL_ROUTER_PROVIDER_NAME;

  constructor(private readonly registry: ProviderRegistry) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      // These capabilities are model-specific. The meta-provider stays conservative and delegates
      // exact capability enforcement to the selected concrete provider.
      supportsImages: false,
      supportsTools: false,
      models: await this.registry.listModels(),
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    const provider = await this.registry.resolveModel(request.model.model);
    const result = await provider.runTurn({
      ...request,
      model: {
        ...request.model,
        provider: provider.name,
      },
    }, ctx);
    return {
      ...result,
      providerMetadata: {
        routedProvider: provider.name,
        ...(result.providerMetadata ?? {}),
      },
    };
  }
}
