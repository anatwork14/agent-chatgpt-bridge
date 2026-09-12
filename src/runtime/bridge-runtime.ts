import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { AppConfig } from "../config";
import { providerConfig } from "../config";
import { SubprocessJsonlAdapter } from "../agents/subprocess-jsonl";
import { AuditStore } from "../persistence/audit-store";
import { initDatabase } from "../persistence/database";
import { MessageStore } from "../persistence/message-store";
import { RunStore } from "../persistence/run-store";
import { SessionStore } from "../persistence/session-store";
import { TurnStore } from "../persistence/turn-store";
import { SessionManager } from "../core/session-manager";
import { RunController } from "../core/run-controller";
import { BridgeError } from "../core/errors";
import type { ConversationProvider } from "../providers/provider";
import { ChatGPTWebConversationProvider } from "../providers/chatgpt-web/provider";
import { createBridgeApi } from "../protocols/rest/routes";
import { AgentChatGptMcpServer } from "../protocols/mcp/server";

export const DEFAULT_BRIDGE_PORT = 8765;

export interface BridgeRuntime {
  provider: ConversationProvider;
  sessionManager: SessionManager;
  runController: RunController;
  api: Hono;
  mcp: AgentChatGptMcpServer;
  defaultModel: string;
  models: string[];
  apiToken: string;
  host: "127.0.0.1";
  port: number;
  baseUrl: string;
  recoveredInterruptedTurns: number;
}

export interface BridgeRuntimeDependencies {
  provider?: ConversationProvider;
  port?: number;
  apiToken?: string;
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
    throw new BridgeError("model_unavailable", "No ChatGPT Web model route is available", false);
  }
  return first;
}

export async function createBridgeRuntime(
  config: AppConfig,
  dependencies: BridgeRuntimeDependencies = {},
): Promise<BridgeRuntime> {
  initDatabase();

  const provider = dependencies.provider
    ?? new ChatGPTWebConversationProvider(providerConfig(config));
  const capabilities = await provider.capabilities();
  const models = [...capabilities.models];
  const defaultModel = preferredBridgeModel(models);

  const sessionManager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { [provider.name]: provider },
  );
  const recoveredInterruptedTurns = sessionManager.recoverInterruptedTurns();

  const runController = new RunController(
    new RunStore(),
    sessionManager,
    new AuditStore(),
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
  const port = resolveBridgePort(dependencies.port);
  const host = "127.0.0.1" as const;
  const api = createBridgeApi(sessionManager, {
    apiToken,
    defaultProvider: provider.name,
    defaultModel,
    listModels: async () => [...(await provider.capabilities()).models],
    runController,
  });
  const mcp = new AgentChatGptMcpServer(sessionManager, {
    defaultProvider: provider.name,
    defaultModel,
    listModels: async () => [...(await provider.capabilities()).models],
  });

  return {
    provider,
    sessionManager,
    runController,
    api,
    mcp,
    defaultModel,
    models,
    apiToken,
    host,
    port,
    baseUrl: `http://${host}:${port}/bridge/v1`,
    recoveredInterruptedTurns,
  };
}
