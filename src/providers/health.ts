import type { BridgeTurnResult } from "../core/domain";
import { BridgeError } from "../core/errors";

export type ProviderHealthState =
  | "healthy"
  | "unavailable"
  | "rate_limited"
  | "cooldown"
  | "misconfigured";

export type ProviderHealthOperation = "discovery" | "validation" | "turn" | "policy";

export interface ProviderHealthObservation {
  provider: string;
  state: ProviderHealthState;
  operation: ProviderHealthOperation;
  observedAt: string;
  /** Stable bridge/provider error code only. Raw provider messages are intentionally excluded. */
  code?: string;
  retryable?: boolean;
  cooldownUntil?: string;
}

interface HealthClassification {
  state: Exclude<ProviderHealthState, "healthy" | "cooldown">;
  code: string;
  retryable?: boolean;
}

const MISCONFIGURED_CODES = new Set([
  "provider_authentication_failed",
  "provider_protocol_invalid",
  "provider_loop_detected",
]);

const UNAVAILABLE_CODES = new Set([
  "provider_unavailable",
  "browser_not_ready",
  "provider_exception",
  "provider_terminal_missing",
]);

function classifyCode(code: string, retryable?: boolean): HealthClassification | undefined {
  if (code === "client_cancelled") return undefined;
  if (code === "provider_rate_limited") {
    return { state: "rate_limited", code, retryable: retryable ?? true };
  }
  if (MISCONFIGURED_CODES.has(code)) {
    return { state: "misconfigured", code, retryable };
  }
  if (UNAVAILABLE_CODES.has(code) || retryable === true) {
    return { state: "unavailable", code, retryable };
  }
  return undefined;
}

export function classifyProviderError(error: unknown): HealthClassification | undefined {
  if (error instanceof BridgeError) {
    return classifyCode(error.code, error.retryable);
  }
  if (error instanceof DOMException && error.name === "AbortError") return undefined;
  if (error instanceof Error && error.name === "AbortError") return undefined;
  return { state: "unavailable", code: "provider_exception" };
}

export function classifyProviderTurnResult(
  result: BridgeTurnResult,
): { state: "healthy" } | HealthClassification | undefined {
  if (result.status === "completed") return { state: "healthy" };
  if (result.status === "cancelled" || result.error?.code === "client_cancelled") return undefined;
  if (result.status === "incomplete" && result.error?.code === "provider_incomplete") {
    return { state: "healthy" };
  }
  if (result.error) return classifyCode(result.error.code, result.error.retryable);
  return undefined;
}

export interface ProviderHealthTrackerOptions {
  rateLimitCooldownMs?: number;
}

export class ProviderHealthTracker {
  private readonly observations = new Map<string, ProviderHealthObservation>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly options: ProviderHealthTrackerOptions = {},
  ) {
    const cooldownMs = options.rateLimitCooldownMs;
    if (cooldownMs !== undefined && (!Number.isFinite(cooldownMs) || cooldownMs <= 0)) {
      throw new BridgeError(
        "invalid_request",
        "rateLimitCooldownMs must be a positive finite number when configured",
        false,
      );
    }
  }

  private record(
    provider: string,
    state: ProviderHealthState,
    operation: ProviderHealthOperation,
    details: Pick<ProviderHealthObservation, "code" | "retryable" | "cooldownUntil"> = {},
    observedAt: Date = this.now(),
  ): ProviderHealthObservation {
    const observation: ProviderHealthObservation = {
      provider,
      state,
      operation,
      observedAt: observedAt.toISOString(),
      ...details,
    };
    this.observations.set(provider, observation);
    return { ...observation };
  }

  private active(provider: string): ProviderHealthObservation | undefined {
    const observation = this.observations.get(provider);
    if (observation?.state !== "cooldown" || !observation.cooldownUntil) return observation;
    const deadline = Date.parse(observation.cooldownUntil);
    if (Number.isFinite(deadline) && deadline <= this.now().getTime()) {
      // Expiry means "unknown until retried", not "healthy". Removing the stale observation lets
      // the next real provider operation establish the new state without manufacturing success.
      this.observations.delete(provider);
      return undefined;
    }
    return observation;
  }

  private recordClassified(
    provider: string,
    classified: HealthClassification,
    operation: ProviderHealthOperation,
  ): ProviderHealthObservation {
    const cooldownMs = this.options.rateLimitCooldownMs;
    if (classified.state === "rate_limited" && cooldownMs !== undefined) {
      const observedAt = this.now();
      return this.record(provider, "cooldown", "policy", {
        code: classified.code,
        retryable: classified.retryable,
        cooldownUntil: new Date(observedAt.getTime() + cooldownMs).toISOString(),
      }, observedAt);
    }
    return this.record(provider, classified.state, operation, {
      code: classified.code,
      retryable: classified.retryable,
    });
  }

  recordSuccess(provider: string, operation: ProviderHealthOperation): ProviderHealthObservation {
    const current = this.active(provider);
    if (current?.state === "cooldown") return { ...current };
    return this.record(provider, "healthy", operation);
  }

  recordError(
    provider: string,
    error: unknown,
    operation: ProviderHealthOperation,
  ): ProviderHealthObservation | undefined {
    const classified = classifyProviderError(error);
    if (!classified) return undefined;
    return this.recordClassified(provider, classified, operation);
  }

  recordTurn(provider: string, result: BridgeTurnResult): ProviderHealthObservation | undefined {
    const classified = classifyProviderTurnResult(result);
    if (!classified) return undefined;
    if (classified.state === "healthy") return this.recordSuccess(provider, "turn");
    return this.recordClassified(provider, classified, "turn");
  }

  markCooldown(
    provider: string,
    cooldownUntil: Date,
    code = "provider_rate_limited",
  ): ProviderHealthObservation {
    return this.record(provider, "cooldown", "policy", {
      code,
      retryable: true,
      cooldownUntil: cooldownUntil.toISOString(),
    });
  }

  get(provider: string): ProviderHealthObservation | undefined {
    const observation = this.active(provider);
    return observation ? { ...observation } : undefined;
  }

  list(providerOrder?: readonly string[]): ProviderHealthObservation[] {
    const providers = providerOrder ?? [...this.observations.keys()];
    return providers
      .map(provider => this.active(provider))
      .filter((value): value is ProviderHealthObservation => value !== undefined)
      .map(value => ({ ...value }));
  }
}
