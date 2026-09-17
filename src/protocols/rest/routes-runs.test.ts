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

test("REST API accepts ACP profile selection and passes explicit permission policy to the run controller", async () => {
  initDatabase(":memory:");
  const provider = new FakeConversationProvider();
  const sessionManager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { fake: provider },
  );
  const captured: unknown[] = [];
  const runController = {
    startRun: async (...args: unknown[]) => {
      captured.push(...args);
      return {
        id: "run_acp",
        sessionId: "ses_1",
        agentAdapterId: "acp:cursor",
        objective: "use ACP",
        status: "running",
        round: 0,
        budget: { maxRounds: 2, maxWallClockMs: 1000, maxConsecutiveFailures: 1 },
        createdAt: "2026-09-13T00:00:00.000Z",
      };
    },
  };
  const app = createBridgeApi(sessionManager, {
    defaultProvider: "fake",
    defaultModel: "fake-model",
    runController: runController as any,
  });

  const response = await app.request("/bridge/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "use ACP",
      agent_adapter: { type: "acp:cursor", permission_mode: "allow_readonly" },
      chatgpt: { session_id: "ses_1" },
    }),
  });
  expect(response.status).toBe(201);
  expect(captured[0]).toBe("ses_1");
  expect(captured[2]).toBe("acp:cursor");
  expect(captured[5]).toEqual({ profile: undefined, permissionMode: "allow_readonly" });
});

test("REST API rejects unsupported ACP delegation and malformed command configuration", async () => {
  initDatabase(":memory:");
  const sessionManager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { fake: new FakeConversationProvider() },
  );
  const runController = { startRun: async () => { throw new Error("must not start"); } } as any;
  const app = createBridgeApi(sessionManager, { runController });

  const delegated = await app.request("/bridge/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "use ACP",
      agent_adapter: { type: "acp:cursor", permission_mode: "delegate" },
      chatgpt: { session_id: "ses_1" },
    }),
  });
  expect(delegated.status).toBe(400);

  const malformed = await app.request("/bridge/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "use ACP",
      agent_adapter: { type: "acp", command: ["agent"], permission_mode: "not-a-mode" },
      chatgpt: { session_id: "ses_1" },
    }),
  });
  expect(malformed.status).toBe(400);
});
