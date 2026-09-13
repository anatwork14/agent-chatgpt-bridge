import { expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { BridgeError } from "../core/errors";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import { closeDatabase, initDatabase } from "../persistence/database";
import { FakeConversationProvider } from "../providers/fake/provider";
import type { ConversationProvider, ProviderCapabilities } from "../providers/provider";
import {
  assertCodexRouterDoesNotTargetBridge,
  createBridgeRuntime,
} from "./bridge-runtime";

class OfflineOptionalProvider implements ConversationProvider {
  public readonly name = "offline-provider";

  async capabilities(): Promise<ProviderCapabilities> {
    throw new BridgeError("provider_unavailable", "offline provider diagnostic", true);
  }

  async runTurn(_request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    throw new BridgeError("provider_unavailable", "offline provider diagnostic", true);
  }
}

test("codex-router provider refuses recursive routes to the bridge listener", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8765/v1",
    "http://localhost:8765/_codex-router/example/v1",
    "http://[::1]:8765/v1",
  ]) {
    expect(() => assertCodexRouterDoesNotTargetBridge(baseUrl, 8765))
      .toThrow("refusing a recursive provider route");
  }
});

test("codex-router provider accepts a distinct local router port", () => {
  expect(() => assertCodexRouterDoesNotTargetBridge(
    "http://127.0.0.1:4202/_codex-router/example/v1",
    8765,
  )).not.toThrow();
});

test("composed runtime exposes authenticated provider health without failing on an optional degraded provider", async () => {
  closeDatabase();
  initDatabase(":memory:");
  const runtime = await createBridgeRuntime(defaultConfig(), {
    provider: new FakeConversationProvider(),
    additionalProviders: [new OfflineOptionalProvider()],
    codexRouter: false,
    apiToken: "runtime-health-secret",
    port: 8766,
  });

  try {
    const denied = await runtime.api.request("/bridge/v1/providers/health");
    expect(denied.status).toBe(401);

    const allowed = await runtime.api.request("/bridge/v1/providers/health", {
      headers: { Authorization: "Bearer runtime-health-secret" },
    });
    expect(allowed.status).toBe(200);
    const payload = await allowed.json() as {
      providers: Array<{
        provider: string;
        state: string;
        operation: string;
        code?: string;
      }>;
    };
    expect(payload.providers).toEqual([
      expect.objectContaining({
        provider: "fake",
        state: "healthy",
        operation: "discovery",
      }),
      expect.objectContaining({
        provider: "offline-provider",
        state: "unavailable",
        operation: "discovery",
        code: "provider_unavailable",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("offline provider diagnostic");
  } finally {
    await runtime.close();
  }
});
