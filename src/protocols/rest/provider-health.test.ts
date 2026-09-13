import { expect, test } from "bun:test";
import type { ProviderHealthObservation } from "../../providers/health";
import { createProviderHealthApi } from "./provider-health";

const observations: ProviderHealthObservation[] = [
  {
    provider: "chatgpt-web",
    state: "healthy",
    operation: "discovery",
    observedAt: "2026-09-13T00:00:00.000Z",
  },
  {
    provider: "codex-router",
    state: "rate_limited",
    operation: "turn",
    observedAt: "2026-09-13T00:00:01.000Z",
    code: "provider_rate_limited",
    retryable: true,
  },
];

test("provider health API is protected by the bridge bearer token", async () => {
  const app = createProviderHealthApi({
    apiToken: "health-secret",
    listProviderHealth: () => observations,
  });

  const denied = await app.request("/bridge/v1/providers/health");
  expect(denied.status).toBe(401);
  expect((await denied.json() as any).error.code).toBe("authentication_required");

  const allowed = await app.request("/bridge/v1/providers/health", {
    headers: { Authorization: "Bearer health-secret" },
  });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ providers: observations });
});

test("provider health API does not add provider diagnostic text", async () => {
  const app = createProviderHealthApi({
    listProviderHealth: () => observations,
  });
  const response = await app.request("/bridge/v1/providers/health");
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(text).toContain("provider_rate_limited");
  expect(text).not.toContain("http://");
  expect(text).not.toContain("https://");
});
