import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "./database";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDbPath = path.join(os.tmpdir(), `test-bridge-${Date.now()}.db`);

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + "-wal")) fs.unlinkSync(testDbPath + "-wal");
    if (fs.existsSync(testDbPath + "-shm")) fs.unlinkSync(testDbPath + "-shm");
  }
});

test("Database initializes correctly with all tables", () => {
  const db = initDatabase(testDbPath);

  const tablesResult = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  const tables = tablesResult.map(t => t.name);

  expect(tables).toContain("sessions");
  expect(tables).toContain("messages");
  expect(tables).toContain("turns");
  expect(tables).toContain("runs");
  expect(tables).toContain("run_events");
  expect(tables).toContain("idempotency");
  expect(tables).toContain("audit_events");
});

test("Database initializes SQLite :memory: without filesystem setup", () => {
  const db = initDatabase(":memory:");
  const row = db.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
  expect(row.count).toBe(1);
});

test("Database crash-state recovery", () => {
  // Simulate writing something, not closing properly, then reopening.
  const db1 = initDatabase(testDbPath);
  db1.exec(`INSERT INTO sessions (id, provider, model, status, created_at, updated_at) VALUES ('ses_1', 'chatgpt-web', 'gpt-4', 'active', '2023', '2023')`);

  // Open a second SQLite handle to prove committed state is visible independently.
  const db2 = new (require("bun:sqlite").Database)(testDbPath);
  const result = db2.query("SELECT * FROM sessions WHERE id = 'ses_1'").get();
  expect(result).toBeTruthy();
  expect((result as any).id).toBe("ses_1");
  db2.close();
});
