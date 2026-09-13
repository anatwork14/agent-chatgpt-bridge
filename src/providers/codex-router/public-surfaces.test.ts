import { afterEach, expect, test } from "bun:test";
import type {
  AgentTurnInput,
  BridgeTurnRequest,
  BridgeTurnResult,
  ExternalAgentAdapter,
} from "../../core/domain";
import type { BridgeEvent } from "../../core/events";
import { RunController } from "../../core/run-controller";
import { SessionManager } from "../../core/session-manager";
import { AuditStore } from "../../persistence/audit-store";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { RunStore } from "../../persistence/run-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { AgentChatGptMcpServer } from "../../protocols/mcp/server";
import { createResponsesApi } from "../../protocols/responses/routes";
import { createBridgeApi } from "../../protocols/rest/routes";
import type { ConversationProvider, ProviderCapabilities } from "../provider";
import { ModelRouterConversationProvider, ProviderRegistry } from "../registry";

const ROUTED_MODEL = "codex-router/test-model";

class RoutedRecordingProvider implements ConversationProvider {
  readonly name = "codex-router";
  readonly requests: BridgeTurnRequest[] = [];

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportsImages: false,
      supportsTools: false,
      models: [ROUTED_MODEL],
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    this.requests.push(request);
    const turnId = request.requestId;
    const text = `routed:${request.source}:${request.model.provider}:${request.model.model}`;
    ctx.emit({ type: "turn.started", sessionId: request.sessionId, turnId });
    ctx.emit({ type: "text.delta", sessionId: request.sessionId, turnId, delta: text });
    const result: BridgeTurnResult = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId,
      status: "completed",
      text,
    };
    ctx.emit({ type: "turn.completed", sessionId: request.sessionId, turnId, result });
    return result;
  }
}

class OneRoundAgent implements ExternalAgentAdapter {
  readonly id = "one-round";

  async next(input: AgentTurnInput) {
    if (input.round === 0) return { type: "message" as const, content: "relay to routed model" };
    return { type: "done" as const, summary: input.lastChatGptResponse?.text ?? "missing response" };
  }
}

afterEach(() => closeDatabase());

function fixture() {
  initDatabase(":memory:");
  const routed = new RoutedRecordingProvider();
  const registry = new ProviderRegistry([routed]);
  const router = new ModelRouterConversationProvider(registry);
  const turnStore = new TurnStore();
  const manager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    turnStore,
    { [router.name]: router },
  );
  const listModels = () => registry.listModels();
  return { routed, registry, router, turnStore, manager, listModels };
}

test("one namespaced routed model works through REST, MCP, Responses, and autonomous relay", async () => {
  const { routed, router, turnStore, manager, listModels } = fixture();

  const rest = createBridgeApi(manager, {
    defaultProvider: router.name,
    defaultModel: ROUTED_MODEL,
    listModels,
  });
  const restSessionResponse = await rest.request("/bridge/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: ROUTED_MODEL }),
  });
  expect(restSessionResponse.status).toBe(201);
  const restSession = await restSessionResponse.json() as any;
  const restTurnResponse = await rest.request(`/bridge/v1/sessions/${restSession.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: "REST routed request" }] }),
  });
  expect(restTurnResponse.status).toBe(200);
  expect((await restTurnResponse.json() as any).message.content[0].text)
    .toBe(`routed:rest:codex-router:${ROUTED_MODEL}`);

  const mcp = new AgentChatGptMcpServer(manager, {
    defaultProvider: router.name,
    defaultModel: ROUTED_MODEL,
    listModels,
  });
  const mcpResult = await mcp.handleToolCall("chatgpt_ask", {
    model: ROUTED_MODEL,
    message: "MCP routed request",
  }) as any;
  expect(mcpResult.isError).not.toBe(true);
  const mcpPayload = JSON.parse(mcpResult.content[0].text);
  expect(mcpPayload.text).toBe(`routed:mcp:codex-router:${ROUTED_MODEL}`);

  const responses = createResponsesApi(manager, {
    defaultProvider: router.name,
    defaultModel: ROUTED_MODEL,
    listModels,
    turnStore,
  });
  const responsesResult = await responses.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: ROUTED_MODEL, input: "Responses routed request" }),
  });
  expect(responsesResult.status).toBe(200);
  const responsesPayload = await responsesResult.json() as any;
  expect(responsesPayload.output[0].content[0].text)
    .toBe(`routed:responses:codex-router:${ROUTED_MODEL}`);

  const relaySession = await manager.create({ provider: router.name, model: ROUTED_MODEL });
  const runStore = new RunStore();
  const controller = new RunController(
    runStore,
    manager,
    new AuditStore(),
    id => {
      expect(id).toBe("one-round");
      return new OneRoundAgent();
    },
  );
  const run = await controller.startRun(
    relaySession.id,
    "Exercise the routed model through autonomous collaboration",
    "one-round",
    undefined,
    { maxRounds: 2, maxWallClockMs: 5_000, maxConsecutiveFailures: 1 },
  );
  await controller.waitForIdle();
  const completedRun = controller.getRun(run.id);
  expect(completedRun?.status).toBe("completed");
  expect(completedRun?.finalSummary).toBe(`routed:relay:codex-router:${ROUTED_MODEL}`);

  expect(routed.requests.map(request => request.source)).toEqual([
    "rest",
    "mcp",
    "responses",
    "relay",
  ]);
  for (const request of routed.requests) {
    expect(request.model.provider).toBe("codex-router");
    expect(request.model.model).toBe(ROUTED_MODEL);
  }
});
