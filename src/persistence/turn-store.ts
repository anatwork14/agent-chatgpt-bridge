import { getDatabase } from "./database";

export type PersistedTurnStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_tool"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface TurnData {
  id: string;
  requestId: string;
  sessionId: string;
  status: PersistedTurnStatus;
  source: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  usageJson?: string;
}

function mapTurnRow(row: any): TurnData {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
    status: row.status,
    source: row.source,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    usageJson: row.usage_json ?? undefined,
  };
}

export class TurnStore {
  create(turn: TurnData): void {
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
    const row = getDatabase().query("SELECT * FROM turns WHERE id = ?").get(id) as any;
    return row ? mapTurnRow(row) : null;
  }

  getActiveBySession(sessionId: string): TurnData | null {
    const row = getDatabase().query(`
      SELECT * FROM turns
      WHERE session_id = ? AND status IN ('queued', 'starting', 'running', 'waiting_tool')
      ORDER BY COALESCE(started_at, '') DESC
      LIMIT 1
    `).get(sessionId) as any;
    return row ? mapTurnRow(row) : null;
  }

  update(id: string, updates: Partial<TurnData>): void {
    const db = getDatabase();
    const current = this.get(id);
    if (!current) throw new Error(`Turn not found: ${id}`);
    const merged: TurnData = { ...current, ...updates };
    db.prepare(`
      UPDATE turns SET
        request_id = ?, session_id = ?, status = ?, source = ?, started_at = ?, completed_at = ?,
        error_code = ?, error_message = ?, usage_json = ?
      WHERE id = ?
    `).run(
      merged.requestId,
      merged.sessionId,
      merged.status,
      merged.source,
      merged.startedAt || null,
      merged.completedAt || null,
      merged.errorCode || null,
      merged.errorMessage || null,
      merged.usageJson || null,
      id
    );
  }

  markInterruptedTurnsFailed(now = new Date().toISOString()): number {
    const result = getDatabase().prepare(`
      UPDATE turns
      SET status = 'failed', completed_at = ?, error_code = 'process_interrupted',
          error_message = 'Bridge process stopped before this turn reached a terminal state.'
      WHERE status IN ('queued', 'starting', 'running', 'waiting_tool')
    `).run(now);
    return Number(result.changes);
  }
}
