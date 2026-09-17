import { expect, test } from "bun:test";
import type { BridgeTurnResult } from "../core/domain";
import { BridgeError } from "../core/errors";
import {
  classifyProviderError,
  classifyProviderTurnResult,
  ProviderHealthTracker,
} from "./health";

function result(
  status: BridgeTurnResult["status"],
  error?: BridgeTurnResult["error"],
): BridgeTurnResult {
  return {
    requestId: "req_health",
    sessionId: "ses_health",
    turnId: "turn_health",
    status,
    text: "",
    error,
  };
}

test("provider health classifies stable bridge errors without retaining messages", () => {
  const rateLimit = new BridgeError(
    "provider_rate_limited",
    "secret provider diagnostic that must not be persisted",
    true,
  );
  expect(classifyProviderError(rateLimit)).toEqual({
    state: "rate_limited",
    code: "provider_rate_limited",
    retryable: true,
  });

  expect(classifyProviderError(new BridgeError(
    "provider_authentication_failed",
    "bad credential",
    false,
  ))).toEqual({
    state: "misconfigured",
    code: "provider_authentication_failed",
    retryable: false,
  });

  expect(classifyProviderError(new BridgeError(
    "provider_unavailable",
    "offline",
    true,
  ))).toEqual({
    state: "unavailable",
    code: "provider_unavailable",
    retryable: true,
  });
});

test("caller and cancellation failures do not poison provider health", () => {
  expect(classifyProviderError(new BridgeError("invalid_request", "caller error", false))).toBeUndefined();
  expect(classifyProviderError(new BridgeError("client_cancelled", "cancelled", false))).toBeUndefined();
  expect(classifyProviderTurnResult(result("cancelled", {
    code: "client_cancelled",
    message: "cancelled",
    retryable: false,
  }))).toBeUndefined();
});

test("successful and provider-incomplete turns prove reachability", () => {
  expect(classifyProviderTurnResult(result("completed"))).toEqual({ state: "healthy" });
  expect(classifyProviderTurnResult(result("incomplete", {
    code: "provider_incomplete",
    message: "token budget exhausted",
    retryable: false,
  }))).toEqual({ state: "healthy" });
});

test("tracker records only bridge-safe observation metadata and can heal", () => {
  const timestamps = [
    new Date("2026-09-13T00:00:00.000Z"),
    new Date("2026-09-13T00:00:01.000Z"),
  ];
  const tracker = new ProviderHealthTracker(() => timestamps.shift()!);

  tracker.recordError(
    "codex-router",
    new BridgeError("provider_rate_limited", "https://secret.invalid/capability/v1", true),
    "turn",
  );
  expect(tracker.get("codex-router")).toEqual({
    provider: "codex-router",
    state: "rate_limited",
    operation: "turn",
    observedAt: "2026-09-13T00:00:00.000Z",
    code: "provider_rate_limited",
    retryable: true,
  });
  expect(JSON.stringify(tracker.get("codex-router"))).not.toContain("secret.invalid");

  tracker.recordTurn("codex-router", result("completed"));
  expect(tracker.get("codex-router")?.state).toBe("healthy");
  expect(tracker.get("codex-router")?.observedAt).toBe("2026-09-13T00:00:01.000Z");
});

test("manual cooldown remains active until its deadline", () => {
  const tracker = new ProviderHealthTracker(() => new Date("2026-09-13T00:00:00.000Z"));
  tracker.markCooldown("codex-router", new Date("2026-09-13T00:00:30.000Z"));
  expect(tracker.get("codex-router")).toEqual({
    provider: "codex-router",
    state: "cooldown",
    operation: "policy",
    observedAt: "2026-09-13T00:00:00.000Z",
    code: "provider_rate_limited",
    retryable: true,
    cooldownUntil: "2026-09-13T00:00:30.000Z",
  });
});

test("configured rate limit enters cooldown, cannot heal early, and expires to unknown", () => {
  let now = new Date("2026-09-13T00:00:00.000Z");
  const tracker = new ProviderHealthTracker(() => now, { rateLimitCooldownMs: 30_000 });

  tracker.recordError(
    "codex-router",
    new BridgeError("provider_rate_limited", "429", true),
    "turn",
  );
  expect(tracker.get("codex-router")).toEqual({
    provider: "codex-router",
    state: "cooldown",
    operation: "policy",
    observedAt: "2026-09-13T00:00:00.000Z",
    code: "provider_rate_limited",
    retryable: true,
    cooldownUntil: "2026-09-13T00:00:30.000Z",
  });

  now = new Date("2026-09-13T00:00:10.000Z");
  tracker.recordSuccess("codex-router", "discovery");
  expect(tracker.get("codex-router")?.state).toBe("cooldown");

  now = new Date("2026-09-13T00:00:30.000Z");
  expect(tracker.get("codex-router")).toBeUndefined();

  tracker.recordSuccess("codex-router", "turn");
  expect(tracker.get("codex-router")).toEqual({
    provider: "codex-router",
    state: "healthy",
    operation: "turn",
    observedAt: "2026-09-13T00:00:30.000Z",
  });
});

test("rate-limit cooldown duration must be explicitly positive and finite", () => {
  for (const rateLimitCooldownMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new ProviderHealthTracker(
      () => new Date("2026-09-13T00:00:00.000Z"),
      { rateLimitCooldownMs },
    )).toThrow("rateLimitCooldownMs must be a positive finite number");
  }
});
