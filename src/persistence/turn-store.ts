import { getDatabase } from "./database";

export interface TurnData {
  id: string;
  requestId: string;
  sessionId: string;
  status: string;
  source: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  usageJson?: string;
}

export class TurnStore {
  create(turn: TurnData) {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO turns (id, request_id, session_id, status, source, started_at, completed_at, error_code, error_message, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.requestId,
      turn.sessionId,
      turn.status,
      turn.source,
      turn.startedAt || null,
      turn.completedAt || null,
      turn.errorCode || null,
      turn.errorMessage || null,
      turn.usageJson || null
    );
  }

  get(id: string): TurnData | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM turns WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.request_id,
      sessionId: row.session_id,
      status: row.status,
      source: row.source,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      usageJson: row.usage_json,
    };
  }
}
