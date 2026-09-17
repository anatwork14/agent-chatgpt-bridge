import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config";

let db: Database | null = null;

export function getDatabasePath(): string {
  return path.join(getConfigDir(), "state", "bridge.db");
}

export function initDatabase(dbPath: string = getDatabasePath()): Database {
  if (db) return db;

  // SQLite's canonical in-memory database name is not a filesystem path. Treating it like one
  // is harmless on many Unix hosts but fails on Windows/Bun when mkdirSync(".", { recursive:true })
  // reports EEXIST. Keep all owner-only directory/file permissions for real database files only.
  const inMemory = dbPath === ":memory:";
  if (!inMemory) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows ACLs are owned by the installer/runtime user. */ }
  }

  db = new Database(dbPath);
  if (!inMemory) {
    try { fs.chmodSync(dbPath, 0o600); } catch { /* Windows ACLs are owned by the installer/runtime user. */ }
  }

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  runMigrations(db);
  return db;
}

export function getDatabase(): Database {
  if (!db) throw new Error("Database not initialized");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY
    );
  `);

  const currentVersionResult = database.query("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number | null };
  const currentVersion = currentVersionResult?.v || 0;

  if (currentVersion < 1) {
    database.transaction(() => {
      database.exec(`
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

      database.exec(`
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

      database.exec(`
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

      database.exec(`
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

      database.exec(`
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

      database.exec(`
        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);

      database.exec(`
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

      database.exec("INSERT INTO schema_migrations (version) VALUES (1)");
    })();
  }

  if (currentVersion < 2) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE role_based_runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 0,
          budget_json TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          active_participant_id TEXT,
          final_summary TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY(session_id) REFERENCES sessions(id)
        );
      `);

      database.exec(`
        CREATE INDEX idx_role_based_runs_session
        ON role_based_runs(session_id);
      `);

      database.exec(`
        CREATE INDEX idx_role_based_runs_status
        ON role_based_runs(status);
      `);

      database.exec(`
        CREATE TABLE collaboration_participants (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          role_snapshot_json TEXT NOT NULL,
          config_snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL,
          turns_executed INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          sequence_index INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_active_at TEXT,
          FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
          UNIQUE(run_id, sequence_index)
        );
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_participants_run
        ON collaboration_participants(run_id);
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_participants_role
        ON collaboration_participants(run_id, role_id);
      `);

      database.exec(`
        CREATE TABLE collaboration_turns (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          round INTEGER NOT NULL,
          turn_index INTEGER NOT NULL,
          participant_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          status TEXT NOT NULL,
          input_summary TEXT NOT NULL,
          decision_json TEXT,
          error_json TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER,
          FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
          FOREIGN KEY(participant_id) REFERENCES collaboration_participants(id),
          UNIQUE(run_id, turn_index)
        );
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_turns_run
        ON collaboration_turns(run_id, turn_index);
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_turns_participant
        ON collaboration_turns(participant_id, turn_index);
      `);

      database.exec(`
        CREATE TABLE collaboration_messages (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          sequence_index INTEGER NOT NULL,
          sender_participant_id TEXT NOT NULL,
          sender_role_id TEXT NOT NULL,
          decision_type TEXT NOT NULL,
          content_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
          FOREIGN KEY(turn_id) REFERENCES collaboration_turns(id) ON DELETE CASCADE,
          FOREIGN KEY(sender_participant_id) REFERENCES collaboration_participants(id),
          UNIQUE(run_id, sequence_index)
        );
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_messages_run
        ON collaboration_messages(run_id, sequence_index);
      `);

      database.exec(`
        CREATE INDEX idx_collaboration_messages_turn
        ON collaboration_messages(turn_id);
      `);

      database.exec("INSERT INTO schema_migrations (version) VALUES (2);");
    })();
  }
}
