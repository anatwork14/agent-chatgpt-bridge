import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let db: Database | null = null;

export function getDatabasePath(): string {
  const home = os.homedir();
  return path.join(home, ".agent-chatgpt-bridge", "state", "bridge.db");
}

export function initDatabase(dbPath: string = getDatabasePath()): Database {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  
  // Enable WAL and foreign keys
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  
  runMigrations(db);
  
  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(db: Database) {
  // Create schema version table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY
    );
  `);

  const currentVersionResult = db.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number | null };
  const currentVersion = currentVersionResult?.v || 0;

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(`
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
      `);

      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY(session_id) REFERENCES sessions(id)
        );
      `);

      db.exec(`
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
      `);

      db.exec(`
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
      `);

      db.exec(`
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
      `);

      db.exec(`
        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);

      db.exec(`
        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          session_id TEXT,
          turn_id TEXT,
          run_id TEXT,
          payload_json TEXT,
          created_at TEXT NOT NULL
        );
      `);
      
      db.exec(`INSERT INTO schema_migrations (version) VALUES (1)`);
    })();
  }
}
