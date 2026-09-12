import { expect, test, afterEach } from "bun:test";
import { RunController } from "./run-controller";
import { RunStore } from "../persistence/run-store";
import { SessionManager } from "./session-manager";
import { FakeConversationProvider } from "../providers/fake/provider";
import { initDatabase, closeDatabase } from "../persistence/database";
import { SessionStore } from "../persistence/session-store";
import { MessageStore } from "../persistence/message-store";
import { TurnStore } from "../persistence/turn-store";
import type { ExternalAgentAdapter, AgentDecision } from "./domain";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(os.tmpdir(), `test-bridge-run-${Date.now()}.db`);

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + "-wal")) fs.unlinkSync(testDbPath + "-wal");
  if (fs.existsSync(testDbPath + "-shm")) fs.unlinkSync(testDbPath + "-shm");
});

test("Autonomous relay controller", async () => {
  initDatabase(testDbPath);
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });

  const session = await sm.create({ provider: "chatgpt-web", model: "auto" });

  class MockAgent implements ExternalAgentAdapter {
    id = "mock";
    async next(input: any): Promise<AgentDecision> {
      if (input.round === 0) {
        return { type: "message", content: "Round 0 message" };
      }
      return { type: "done", summary: "Finished!" };
    }
  }

  const runStore = new RunStore();
  const controller = new RunController(runStore, sm, () => new MockAgent());

  const run = await controller.startRun(session.id, "Test run", "mock", [], { maxRounds: 5 });

  // wait for it to complete
  await new Promise(r => setTimeout(r, 100));

  const completedRun = runStore.get(run.id);
  expect(completedRun?.status).toBe("completed");
  expect(completedRun?.round).toBe(1);
  expect(completedRun?.finalSummary).toBe("Finished!");
});

test("Autonomous relay max rounds", async () => {
  initDatabase(testDbPath);
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });

  const session = await sm.create({ provider: "chatgpt-web", model: "auto" });

  class InfiniteAgent implements ExternalAgentAdapter {
    id = "infinite";
    async next(): Promise<AgentDecision> {
      return { type: "message", content: "Never done" };
    }
  }

  const controller = new RunController(new RunStore(), sm, () => new InfiniteAgent());

  const run = await controller.startRun(session.id, "Test limit", "infinite", [], { maxRounds: 2 });
  
  await new Promise(r => setTimeout(r, 100));

  const exhausted = controller.getRun(run.id);
  expect(exhausted?.status).toBe("budget_exhausted");
  expect(exhausted?.round).toBe(2);
});
