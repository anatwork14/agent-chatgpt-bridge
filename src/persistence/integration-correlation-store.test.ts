import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initDatabase } from "./database";
import { IntegrationCorrelationStore } from "./integration-correlation-store";

const dbPath = path.join(os.tmpdir(), `bridge-p6-correlation-${process.pid}.db`);

function cleanup(): void {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const target = dbPath + suffix;
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // Windows may release temporary SQLite files slightly later.
    }
  }
}

afterEach(cleanup);

test("P6 correlation metadata survives SQLite close/reopen", () => {
  cleanup();
  const db = initDatabase(dbPath);
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_p6_corr', 'chatgpt-web', 'high', 'ready', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z');

    INSERT INTO role_based_runs (
      id, session_id, objective, status, round, budget_json, policy_json, created_at
    ) VALUES (
      'rrun_p6_corr',
      'ses_p6_corr',
      'private objective',
      'running',
      0,
      '{"maxTurns":4,"maxParticipants":2,"maxParallelTurns":2,"maxRetriesPerParticipant":1,"maxWallClockMs":60000}',
      '{"roleSequence":["architect"],"terminalRoles":["architect"],"loopMode":"once"}',
      '2026-09-19T00:00:00.000Z'
    );
  `);

  const store = new IntegrationCorrelationStore();
  store.create("rrun_p6_corr", {
    arcProjectId: "project-1",
    arcTaskId: "T001",
    arcSessionId: "S_1234",
    companyWorkflowId: "WF_001",
    companyStepId: "step:collaborate",
    companyRunId: "CRUN_001",
    externalTraceId: "trace/abc-123",
  }, "2026-09-19T00:00:01.000Z");

  closeDatabase();
  initDatabase(dbPath);

  expect(new IntegrationCorrelationStore().get("rrun_p6_corr")).toEqual({
    arcProjectId: "project-1",
    arcTaskId: "T001",
    arcSessionId: "S_1234",
    companyWorkflowId: "WF_001",
    companyStepId: "step:collaborate",
    companyRunId: "CRUN_001",
    externalTraceId: "trace/abc-123",
  });
});
