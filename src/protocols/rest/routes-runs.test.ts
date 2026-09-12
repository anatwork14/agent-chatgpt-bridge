import { afterEach, expect, test } from "bun:test";
import { SessionManager } from "../../core/session-manager";
import type { CollaborationRun } from "../../core/domain";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { createBridgeApi } from "./routes";

afterEach(() => {
  closeDatabase();
});

test("REST API lists persisted autonomous runs", async () => {
  initDatabase(":memory:");
  const provider = new FakeConversationProvider();
  const sessionManager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { fake: provider },
  );
  const runs: CollaborationRun[] = [{
    id: "run_1",
    sessionId: "ses_1",
    agentAdapterId: "subprocess-jsonl",
    objective: "finish the task",
    status: "completed",
    round: 3,
    budget: {
      maxRounds: 20,
      maxWallClockMs: 3_600_000,
      maxConsecutiveFailures: 3,
    },
    createdAt: "2026-09-12T00:00:00.000Z",
    completedAt: "2026-09-12T00:01:00.000Z",
    finalSummary: "done",
  }];
  const app = createBridgeApi(sessionManager, {
    defaultProvider: "fake",
    defaultModel: "fake-model",
    listRuns: () => runs,
  });

  const response = await app.request("/bridge/v1/runs");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(runs);
});
