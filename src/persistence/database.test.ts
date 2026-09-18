import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "./database";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDbPath = path.join(os.tmpdir(), `test-bridge-${Date.now()}.db`);
const upgradeDbPath = path.join(os.tmpdir(), `test-upgrade-${Date.now()}.db`);

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // Windows file locks may linger briefly on temporary test files
  }
}

afterEach(() => {
  closeDatabase();
  for (const p of [testDbPath, upgradeDbPath]) {
    safeUnlink(p);
    safeUnlink(p + "-wal");
    safeUnlink(p + "-shm");
  }
});

test("Database initializes correctly with all tables (legacy and v2)", () => {
  const db = initDatabase(":memory:");

  const tablesResult = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  const tables = tablesResult.map(t => t.name);

  // Legacy tables
  expect(tables).toContain("sessions");
  expect(tables).toContain("messages");
  expect(tables).toContain("turns");
  expect(tables).toContain("runs");
  expect(tables).toContain("run_events");
  expect(tables).toContain("idempotency");
  expect(tables).toContain("audit_events");

  // Migration v2 tables
  expect(tables).toContain("role_based_runs");
  expect(tables).toContain("collaboration_participants");
  expect(tables).toContain("collaboration_turns");
  expect(tables).toContain("collaboration_messages");

  // Migration version check
  const maxVersion = db.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number };
  expect(maxVersion.v).toBe(2);

  const countRow = db.query("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number };
  expect(countRow.c).toBe(2);
});

test("Database migration v2 indexes exist", () => {
  const db = initDatabase(":memory:");
  const indexesResult = db.query(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[];
  const indexes = indexesResult.map(i => i.name);

  expect(indexes).toContain("idx_role_based_runs_session");
  expect(indexes).toContain("idx_role_based_runs_status");
  expect(indexes).toContain("idx_collaboration_participants_run");
  expect(indexes).toContain("idx_collaboration_participants_role");
  expect(indexes).toContain("idx_collaboration_turns_run");
  expect(indexes).toContain("idx_collaboration_turns_participant");
  expect(indexes).toContain("idx_collaboration_messages_run");
  expect(indexes).toContain("idx_collaboration_messages_turn");
});

test("Database initializes SQLite :memory: without filesystem setup", () => {
  const db = initDatabase(":memory:");
  const maxVersion = db.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number };
  expect(maxVersion.v).toBe(2);
});

test("Database migration re-open is idempotent", () => {
  const db1 = initDatabase(testDbPath);
  expect(db1).toBeDefined();
  closeDatabase();

  const db2 = initDatabase(testDbPath);
  const maxVersion = db2.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number };
  expect(maxVersion.v).toBe(2);
  const countRow = db2.query("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number };
  expect(countRow.c).toBe(2);
});

test("Database foreign keys fail closed on invalid references", () => {
  const db = initDatabase(":memory:");

  // Turn cannot reference nonexistent run or participant
  expect(() => {
    db.prepare(`
      INSERT INTO collaboration_turns (id, run_id, round, turn_index, participant_id, role_id, status, input_summary, started_at)
      VALUES ('cturn_fake', 'run_fake', 0, 0, 'part_fake', 'architect', 'running', 'summary', '2026-09-17T00:00:00Z')
    `).run();
  }).toThrow();

  // Message cannot reference nonexistent run, turn, or participant
  expect(() => {
    db.prepare(`
      INSERT INTO collaboration_messages (id, run_id, turn_id, sequence_index, sender_participant_id, sender_role_id, decision_type, content_text, content_hash, created_at)
      VALUES ('cmsg_fake', 'run_fake', 'cturn_fake', 0, 'part_fake', 'architect', 'message', 'text', 'hash', '2026-09-17T00:00:00Z')
    `).run();
  }).toThrow();
});

test("Database upgrades cleanly from v1 to v2 preserving legacy data", () => {
  // Construct a database directly with v1 schema only
  const rawDb = new Database(upgradeDbPath);
  rawDb.exec("PRAGMA journal_mode = WAL;");
  rawDb.exec("PRAGMA foreign_keys = ON;");
  rawDb.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);");
  rawDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      status TEXT NOT NULL,
      conversation_epoch INTEGER NOT NULL DEFAULT 0,
      continuity_mode TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_turn_at TEXT,
      metadata_json TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_adapter_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      budget_json TEXT NOT NULL,
      final_summary TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      round INTEGER,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );
    CREATE TABLE idempotency (
      key TEXT PRIMARY KEY,
      body_hash TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      run_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version) VALUES (1);
  `);

  // Insert legacy data
  rawDb.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_v1', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
    INSERT INTO runs (id, session_id, agent_adapter_id, objective, status, budget_json, created_at)
    VALUES ('run_v1', 'ses_v1', 'acp:claude', 'test legacy run', 'completed', '{"maxRounds":10}', '2026-09-17T00:00:00Z');
  `);
  rawDb.close();

  // Now open through initDatabase which executes pending migrations
  closeDatabase();
  const upgradedDb = initDatabase(upgradeDbPath);

  // Check version is now 2
  const maxVersion = upgradedDb.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number };
  expect(maxVersion.v).toBe(2);

  // Legacy data intact
  const sessionRow = upgradedDb.query("SELECT * FROM sessions WHERE id = 'ses_v1'").get() as any;
  expect(sessionRow).toBeDefined();
  expect(sessionRow.id).toBe("ses_v1");

  const runRow = upgradedDb.query("SELECT * FROM runs WHERE id = 'run_v1'").get() as any;
  expect(runRow).toBeDefined();
  expect(runRow.agent_adapter_id).toBe("acp:claude");

  // New v2 tables exist
  const tables = (upgradedDb.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
  expect(tables).toContain("role_based_runs");
  expect(tables).toContain("collaboration_participants");
  expect(tables).toContain("collaboration_turns");
  expect(tables).toContain("collaboration_messages");
});

test("Database crash-state recovery", () => {
  const db1 = initDatabase(testDbPath);
  db1.exec(`INSERT INTO sessions (id, provider, model, status, created_at, updated_at) VALUES ('ses_1', 'chatgpt-web', 'gpt-4', 'active', '2023', '2023')`);

  const db2 = new (require("bun:sqlite").Database)(testDbPath);
  const result = db2.query("SELECT * FROM sessions WHERE id = 'ses_1'").get();
  expect(result).toBeTruthy();
  expect((result as any).id).toBe("ses_1");
  db2.close();
  closeDatabase();
});
