import { expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { BridgeError } from "../core/errors";
import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import { closeDatabase, getDatabase, initDatabase } from "../persistence/database";
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

class HealthyNamespacedProvider implements ConversationProvider {
  public readonly name = "chatgpt-web";
  public turns = 0;

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: ["chatgpt-web/high"] };
  }

  async runTurn(request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    this.turns += 1;
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "completed",
      text: "fallback reply",
    };
  }
}

class RateLimitedNamespacedProvider implements ConversationProvider {
  public readonly name = "codex-router";
  public turns = 0;

  async capabilities(): Promise<ProviderCapabilities> {
    return { supportsImages: false, supportsTools: false, models: ["codex-router/limited"] };
  }

  async runTurn(request: BridgeTurnRequest): Promise<BridgeTurnResult> {
    this.turns += 1;
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId,
      status: "failed",
      text: "",
      error: {
        code: "provider_rate_limited",
        message: "downstream limit",
        retryable: true,
      },
    };
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

test("invalid provider health policy fails before bridge persistent state opens", async () => {
  closeDatabase();

  await expect(createBridgeRuntime(defaultConfig(), {
    provider: new FakeConversationProvider(),
    codexRouter: false,
    providerHealthPolicy: { rateLimitCooldownMs: 0 },
    apiToken: "invalid-policy-secret",
    port: 8769,
  })).rejects.toMatchObject({ code: "invalid_request", retryable: false });

  expect(() => getDatabase()).toThrow("Database not initialized");
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

test("runtime persists every model-router decision before provider execution", async () => {
  closeDatabase();
  initDatabase(":memory:");
  const runtime = await createBridgeRuntime(defaultConfig(), {
    provider: new FakeConversationProvider(),
    codexRouter: false,
    apiToken: "runtime-audit-secret",
    port: 8767,
  });

  try {
    const session = await runtime.sessionManager.create({
      provider: runtime.defaultProvider,
      model: runtime.defaultModel,
    });
    const result = await runtime.sessionManager.send(session.id, {
      requestId: "turn_runtime_route_audit",
      source: "internal",
      model: { provider: runtime.defaultProvider, model: runtime.defaultModel },
      messages: [{
        id: "msg_runtime_route_audit",
        role: "user",
        content: [{ type: "text", text: "audit this route" }],
        createdAt: new Date(0).toISOString(),
      }],
      stream: false,
    }, { emit: () => undefined });
    expect(result.status).toBe("completed");

    const row = getDatabase().query(`
      SELECT event_type AS eventType,
             session_id AS sessionId,
             turn_id AS turnId,
             payload_json AS payloadJson
      FROM audit_events
      WHERE event_type = 'provider.route'
      ORDER BY id DESC
      LIMIT 1
    `).get() as {
      eventType: string;
      sessionId: string;
      turnId: string;
      payloadJson: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      eventType: "provider.route",
      sessionId: session.id,
      turnId: "turn_runtime_route_audit",
    });
    expect(JSON.parse(row!.payloadJson)).toEqual({
      requestedModel: runtime.defaultModel,
      requestedProvider: "fake",
      selectedModel: runtime.defaultModel,
      selectedProvider: "fake",
      fallback: false,
    });
  } finally {
    await runtime.close();
  }
});

test("runtime applies explicit cooldown fallback without migrating the persistent session model", async () => {
  closeDatabase();
  initDatabase(":memory:");
  const primary = new HealthyNamespacedProvider();
  const limited = new RateLimitedNamespacedProvider();
  const runtime = await createBridgeRuntime(defaultConfig(), {
    provider: primary,
    additionalProviders: [limited],
    codexRouter: false,
    providerHealthPolicy: { rateLimitCooldownMs: 60_000 },
    routingPolicy: {
      fallback: {
        mode: "ordered",
        models: ["chatgpt-web/high"],
        on: ["cooldown"],
      },
    },
    apiToken: "runtime-policy-secret",
    port: 8768,
  });

  try {
    const session = await runtime.sessionManager.create({
      provider: runtime.defaultProvider,
      model: "codex-router/limited",
    });

    const first = await runtime.sessionManager.send(session.id, {
      requestId: "turn_runtime_rate_limit",
      source: "internal",
      model: { provider: runtime.defaultProvider, model: "codex-router/limited" },
      messages: [{
        id: "msg_runtime_rate_limit",
        role: "user",
        content: [{ type: "text", text: "first" }],
        createdAt: new Date(0).toISOString(),
      }],
      stream: false,
    }, { emit: () => undefined });
    expect(first.status).toBe("failed");
    expect(first.error?.code).toBe("provider_rate_limited");
    expect(limited.turns).toBe(1);
    expect(primary.turns).toBe(0);

    const second = await runtime.sessionManager.send(session.id, {
      requestId: "turn_runtime_fallback",
      source: "internal",
      model: { provider: runtime.defaultProvider, model: "codex-router/limited" },
      messages: [{
        id: "msg_runtime_fallback",
        role: "user",
        content: [{ type: "text", text: "second" }],
        createdAt: new Date(1).toISOString(),
      }],
      stream: false,
    }, { emit: () => undefined });
    expect(second.status).toBe("completed");
    expect(second.text).toBe("fallback reply");
    expect(second.providerMetadata).toMatchObject({
      requestedProvider: "codex-router",
      requestedModel: "codex-router/limited",
      routedProvider: "chatgpt-web",
      routedModel: "chatgpt-web/high",
      fallback: true,
      fallbackReasonState: "cooldown",
    });
    expect(limited.turns).toBe(1);
    expect(primary.turns).toBe(1);

    const persistedSession = await runtime.sessionManager.get(session.id);
    expect(persistedSession.provider).toBe("model-router");
    expect(persistedSession.model).toBe("codex-router/limited");

    const healthResponse = await runtime.api.request("/bridge/v1/providers/health", {
      headers: { Authorization: "Bearer runtime-policy-secret" },
    });
    const health = await healthResponse.json() as { providers: Array<Record<string, unknown>> };
    expect(health.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex-router", state: "cooldown" }),
      expect.objectContaining({ provider: "chatgpt-web", state: "healthy" }),
    ]));

    const routeRows = getDatabase().query(`
      SELECT payload_json AS payloadJson
      FROM audit_events
      WHERE event_type = 'provider.route' AND session_id = ?
      ORDER BY id ASC
    `).all(session.id) as Array<{ payloadJson: string }>;
    expect(routeRows.map(row => JSON.parse(row.payloadJson))).toEqual([
      {
        requestedModel: "codex-router/limited",
        requestedProvider: "codex-router",
        selectedModel: "codex-router/limited",
        selectedProvider: "codex-router",
        fallback: false,
      },
      {
        requestedModel: "codex-router/limited",
        requestedProvider: "codex-router",
        selectedModel: "chatgpt-web/high",
        selectedProvider: "chatgpt-web",
        fallback: true,
        reasonState: "cooldown",
      },
    ]);
  } finally {
    await runtime.close();
  }
});
