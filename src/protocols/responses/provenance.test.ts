import { afterEach, expect, test } from "bun:test";
import { SessionManager } from "../../core/session-manager";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { createResponsesApi } from "./routes";

afterEach(() => closeDatabase());

test("previous_response_id cannot reference a turn created by another bridge surface", async () => {
  initDatabase(":memory:");
  const provider = new FakeConversationProvider();
  const turnStore = new TurnStore();
  const manager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    turnStore,
    { fake: provider },
  );
  const session = await manager.create({ provider: "fake", model: "fake-model" });

  const foreignTurnId = "turn_0000000000000000000000000000rest";
  turnStore.create({
    id: foreignTurnId,
    requestId: foreignTurnId,
    sessionId: session.id,
    status: "completed",
    source: "rest",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  });

  const app = createResponsesApi(manager, {
    defaultProvider: "fake",
    defaultModel: "fake-model",
    listModels: async () => ["fake-model"],
    turnStore,
  });
  const response = await app.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      previous_response_id: `resp_${foreignTurnId}`,
      input: "attempt cross-surface continuation",
    }),
  });

  expect(response.status).toBe(400);
  const body = await response.json() as any;
  expect(body.error.code).toBe("invalid_request");
  expect(body.error.message).toContain("previous_response_id was not found");
  expect(await manager.transcript(session.id)).toEqual([]);
});
