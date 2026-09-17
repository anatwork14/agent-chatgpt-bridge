import { getDatabase } from "./database";
import type { CollaborationTurnRecord } from "../core/collaboration-domain";
import { BridgeError } from "../core/errors";

function safeParseJson<T>(json: string | null | undefined, fieldName: string, entityId: string): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new BridgeError(
      "persistence_corruption",
      `Corrupt JSON in '${fieldName}' for turn '${entityId}': ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

function mapTurnRow(row: any): CollaborationTurnRecord {
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    turnIndex: row.turn_index,
    participantId: row.participant_id,
    roleId: row.role_id,
    status: row.status,
    inputSummary: row.input_summary,
    decision: safeParseJson(row.decision_json, "decision_json", row.id),
    error: safeParseJson(row.error_json, "error_json", row.id),
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? row.duration_ms : undefined,
  };
}

export class CollaborationTurnStore {
  create(turn: CollaborationTurnRecord): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO collaboration_turns (
        id, run_id, round, turn_index, participant_id, role_id, status,
        input_summary, decision_json, error_json, started_at, completed_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.runId,
      turn.round,
      turn.turnIndex,
      turn.participantId,
      turn.roleId,
      turn.status,
      turn.inputSummary,
      turn.decision ? JSON.stringify(turn.decision) : null,
      turn.error ? JSON.stringify(turn.error) : null,
      turn.startedAt,
      turn.completedAt || null,
      turn.durationMs ?? null,
    );
  }

  get(id: string): CollaborationTurnRecord | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM collaboration_turns WHERE id = ?").get(id) as any;
    return row ? mapTurnRow(row) : null;
  }

  listByRun(runId: string): CollaborationTurnRecord[] {
    const db = getDatabase();
    const rows = db
      .query("SELECT * FROM collaboration_turns WHERE run_id = ? ORDER BY turn_index ASC")
      .all(runId) as any[];
    return rows.map(mapTurnRow);
  }

  listByParticipant(participantId: string): CollaborationTurnRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        "SELECT * FROM collaboration_turns WHERE participant_id = ? ORDER BY turn_index ASC",
      )
      .all(participantId) as any[];
    return rows.map(mapTurnRow);
  }
}
