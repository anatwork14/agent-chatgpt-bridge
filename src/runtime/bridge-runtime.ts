import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppConfig } from "../config";
import { providerConfig } from "../config";
import { SubprocessJsonlAdapter } from "../agents/subprocess-jsonl";
import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { AuditStore } from "../persistence/audit-store";
import { closeDatabase, initDatabase } from "../persistence/database";
import { MessageStore } from "../persistence/message-store";
import { RunStore } from "../persistence/run-store";
import { SessionStore } from "../persistence/session-store";
import { TurnStore } from "../persistence/turn-store";
import { SessionManager } from "../core/session-manager";
import { RunController } from "../core/run-controller";
import { BridgeError } from "../core/errors";
import type { ConversationProvider } from "../providers/provider";
import type { ProviderHealthTrackerOptions } from "../providers/health";
import type { ProviderRoutingPolicy } from "../providers/policy";
import { ChatGPTWebConversationProvider } from "../providers/chatgpt-web/provider";
import {
  CodexRouterConversationProvider,
  codexRouterProviderOptionsFromEnv,
  type CodexRouterProviderOptions,
} from "../providers/codex-router/provider";
import {
  ModelRouterConversationProvider,
  ProviderRegistry,
} from "../providers/registry";
import { createBridgeApi } from "../protocols/rest/routes";
import { createProviderHealthApi } from "../protocols/rest/provider-health";
import { createResponsesApi } from "../protocols/responses/routes";
import { AgentChatGptMcpServer } from "../protocols/mcp/server";

export const DEFAULT_BRIDGE_PORT = 8765;

export interface BridgeRuntime {
  /** Primary provider retained for backward compatibility and default-model selection. */
  provider: ConversationProvider;
  /** Concrete providers plus the internal model-router meta provider. */
  providers: Readonly<Record<string, ConversationProvider>>;
  sessionManager: SessionManager;
  runController: RunController;
  api: Hono;
  mcp: AgentChatGptMcpServer;
  defaultProvider: string;
  defaultModel: string;
  models: string[];
  apiToken: string;
  host: "127.0.0.1";
  port: number;
  baseUrl: string;
  recoveredInterruptedTurns: number;
  close(): Promise<void>;
}

export interface BridgeRuntimeDependencies {
  /** Replaces the normal ChatGPT Web primary provider, mainly for tests. */
  provider?: ConversationProvider;
  /** Additional concrete providers used by tests or future integrations. */
  additionalProviders?: readonly ConversationProvider[];
  /**
   * Explicit Codex Router configuration. When omitted, the runtime reads
   * AGENT_CHATGPT_CODEX_ROUTER_BASE_URL / AGENT_CHATGPT_CODEX_ROUTER_API_KEY.
   * Pass false to disable environment discovery.
   */
  codexRouter?: CodexRouterProviderOptions | false;
  /** Explicit health policy. Omitted means rate limits are observed but no cooldown timer is invented. */
  providerHealthPolicy?: ProviderHealthTrackerOptions;
  /** Explicit opt-in routing policy. Omitted means no provider/model fallback. */
  routingPolicy?: ProviderRoutingPolicy;
  port?: number;
  apiToken?: string;
  requestShutdown?: () => void;
}

export function bridgeApiToken(config: Pick<AppConfig, "controlToken">): string {
  return createHash("sha256")
    .update("agent-chatgpt-bridge:v1:")
    .update(config.controlToken)
    .digest("base64url");
}

export function resolveBridgePort(
  explicitPort?: number,
  envValue: string | undefined = process.env.AGENT_CHATGPT_BRIDGE_PORT,
): number {
  const raw = explicitPort ?? (envValue ? Number(envValue) : DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
    throw new BridgeError(
      "invalid_request",
      "AGENT_CHATGPT_BRIDGE_PORT must be an integer between 1 and 65535",
      false,
    );
  }
  return raw;
}

export function assertCodexRouterDoesNotTargetBridge(baseUrl: string, bridgePort: number): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // The concrete provider owns complete endpoint validation and will return the canonical error.
    return;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  const endpointPort = parsed.port ? Number(parsed.port) : defaultPort;
  if (loopback && endpointPort === bridgePort) {
    throw new BridgeError(
      "provider_loop_detected",
      "Codex Router base URL points at the Agent ChatGPT Bridge listener; refusing a recursive provider route",
      false,
    );
  }
}

export function preferredBridgeModel(models: readonly string[]): string {
  for (const candidate of [
    "chatgpt-web/high",
    "chatgpt-web/luna",
    "chatgpt-web/zero-risk",
    "chatgpt-web/medium",
    "chatgpt-web/light",
  ]) {
    if (models.includes(candidate)) return candidate;
  }
  const first = models[0];
  if (!first) {
    throw new BridgeError("model_unavailable", "No primary provider model route is available", false);
  }
  return first;
}

export async function createBridgeRuntime(
  config: AppConfig,
  dependencies: BridgeRuntimeDependencies = {},
): Promise<BridgeRuntime> {
  const port = resolveBridgePort(dependencies.port);
  const host = "127.0.0.1" as const;
  const codexRouterOptions = dependencies.codexRouter === false
    ? undefined
    : dependencies.codexRouter ?? codexRouterProviderOptionsFromEnv();
  if (codexRouterOptions) {
    assertCodexRouterDoesNotTargetBridge(codexRouterOptions.baseUrl, port);
  }

  // Validate provider topology before opening persistent state so a configuration error cannot
  // leave an otherwise-unused database handle behind.
  initDatabase();

  const provider = dependencies.provider
    ?? new ChatGPTWebConversationProvider(providerConfig(config));
  const registry = new ProviderRegistry([provider], dependencies.providerHealthPolicy);

  if (codexRouterOptions) {
    registry.register(new CodexRouterConversationProvider(codexRouterOptions));
  }
  for (const additionalProvider of dependencies.additionalProviders ?? []) {
    registry.register(additionalProvider);
  }

  const auditStore = new AuditStore();
  const modelRouter = new ModelRouterConversationProvider(
    registry,
    dependencies.routingPolicy,
    (decision, request) => {
      auditStore.log({
        eventType: "provider.route",
        sessionId: request.sessionId,
        turnId: request.requestId,
        payload: decision,
        createdAt: new Date().toISOString(),
      });
    },
  );
  const providers = registry.asRecord([modelRouter]);

  // The primary provider controls the default model. Additional providers are opt-in by choosing
  // one of their namespaced model IDs, so enabling codex-router cannot silently change behavior.
  const primaryCapabilities = await provider.capabilities();
  const defaultModel = preferredBridgeModel(primaryCapabilities.models);
  const defaultProvider = modelRouter.name;
  const models = await registry.listModels();

  const turnStore = new TurnStore();
  const sessionManager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    turnStore,
    providers,
  );
  const recoveredInterruptedTurns = sessionManager.recoverInterruptedTurns();

  const runStore = new RunStore();
  const runController = new RunController(
    runStore,
    sessionManager,
    auditStore,
    (id, command) => {
      if (id !== "subprocess-jsonl") {
        throw new BridgeError("agent_adapter_failed", `Unsupported agent adapter: ${id}`, false);
      }
      if (!command?.length) {
        throw new BridgeError(
          "agent_protocol_invalid",
          "subprocess-jsonl requires a non-empty command array",
          false,
        );
      }
      return new SubprocessJsonlAdapter(command);
    },
  );

  const apiToken = dependencies.apiToken ?? bridgeApiToken(config);
  const listModels = async () => registry.listModels();
  const bridgeApi = createBridgeApi(sessionManager, {
    apiToken,
    defaultProvider,
    defaultModel,
    listModels,
    runController,
    listRuns: () => runStore.list(),
    requestShutdown: dependencies.requestShutdown,
  });
  const providerHealthApi = createProviderHealthApi({
    apiToken,
    listProviderHealth: () => registry.providerHealth(),
  });
  const responsesApi = createResponsesApi(sessionManager, {
    apiToken,
    defaultProvider,
    defaultModel,
    listModels,
    turnStore,
  });
  const api = new Hono();
  api.route("/", bridgeApi);
  api.route("/", providerHealthApi);
  api.route("/", responsesApi);

  const mcp = new AgentChatGptMcpServer(sessionManager, {
    defaultProvider,
    defaultModel,
    listModels,
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      runController.cancelAllRuns(),
      sessionManager.shutdown(),
    ]);
    const cleanup = await Promise.allSettled([
      closeChatGptBrowserWorkers(),
    ]);
    closeDatabase();

    const failures = [...results, ...cleanup]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Bridge runtime shutdown did not settle cleanly");
    }
  };

  return {
    provider,
    providers,
    sessionManager,
    runController,
    api,
    mcp,
    defaultProvider,
    defaultModel,
    models,
    apiToken,
    host,
    port,
    baseUrl: `http://${host}:${port}/bridge/v1`,
    recoveredInterruptedTurns,
    close,
  };
}
