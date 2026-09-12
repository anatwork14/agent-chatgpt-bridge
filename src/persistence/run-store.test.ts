import { afterEach, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "./database";
import { RunStore } from "./run-store";
import { SessionStore } from "./session-store";

const budget = {
  maxRounds: 20,
  maxWallClockMs: 3_600_000,
  maxConsecutiveFailures: 3,
};

afterEach(() => {
  closeDatabase();
});

test("RunStore lists newest runs first and preserves persisted fields", () => {
  initDatabase(":memory:");
  const sessions = new SessionStore();
  const runs = new RunStore();
  const now = new Date().toISOString();

  sessions.create({
    id: "ses_runs",
    provider: "chatgpt-web",
    model: "chatgpt-web/high",
    status: "ready",
    conversationEpoch: 0,
    createdAt: now,
    updatedAt: now,
  });

  runs.create({
    id: "run_old",
    sessionId: "ses_runs",
    agentAdapterId: "subprocess-jsonl",
    objective: "old objective",
    status: "completed",
    round: 2,
    budget,
    createdAt: "2026-09-12T00:00:00.000Z",
    startedAt: "2026-09-12T00:00:01.000Z",
  });
  runs.update("run_old", {
    completedAt: "2026-09-12T00:00:02.000Z",
    finalSummary: "done",
  });

  runs.create({
    id: "run_new",
    sessionId: "ses_runs",
    agentAdapterId: "subprocess-jsonl",
    objective: "new objective",
    status: "running",
    round: 0,
    budget,
    createdAt: "2026-09-12T01:00:00.000Z",
    startedAt: "2026-09-12T01:00:01.000Z",
  });

  const listed = runs.list();
  expect(listed.map(run => run.id)).toEqual(["run_new", "run_old"]);
  expect(listed[1]?.finalSummary).toBe("done");
  expect(listed[1]?.completedAt).toBe("2026-09-12T00:00:02.000Z");
  expect(listed[0]?.budget).toEqual(budget);
});
