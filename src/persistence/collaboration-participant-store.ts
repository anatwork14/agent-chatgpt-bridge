import { getDatabase } from "./database";
import type {
  ParticipantRecord,
} from "../core/collaboration-domain";
import type {
  ParticipantAssignmentPlan,
  InitialParticipantRecords,
} from "../core/participant-assignment";
import type { PersistedParticipant } from "../core/collaboration-persistence";
import { sanitizeParticipantConfig } from "../core/collaboration-persistence";
import { BridgeError } from "../core/errors";

function safeParseJson<T>(json: string | null | undefined, fieldName: string, entityId: string): T {
  if (!json) {
    throw new BridgeError(
      "persistence_corruption",
      `Missing JSON for field '${fieldName}' in participant '${entityId}'`,
      false,
    );
  }
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new BridgeError(
      "persistence_corruption",
      `Corrupt JSON in '${fieldName}' for participant '${entityId}': ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

function mapParticipantRow(row: any): PersistedParticipant {
  return {
    id: row.id,
    runId: row.run_id,
    roleId: row.role_id,
    adapterId: row.adapter_id,
    roleSnapshot: safeParseJson(row.role_snapshot_json, "role_snapshot_json", row.id),
    configSnapshot: safeParseJson(row.config_snapshot_json, "config_snapshot_json", row.id),
    status: row.status,
    turnsExecuted: row.turns_executed,
    consecutiveFailures: row.consecutive_failures,
    sequenceIndex: row.sequence_index,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at || undefined,
  };
}

export class CollaborationParticipantStore {
  createMany(
    runId: string,
    plans: readonly ParticipantAssignmentPlan[],
    records: InitialParticipantRecords,
  ): void {
    const db = getDatabase();
    const insertStmt = db.prepare(`
      INSERT INTO collaboration_participants (
        id, run_id, role_id, adapter_id, role_snapshot_json, config_snapshot_json,
        status, turns_executed, consecutive_failures, sequence_index, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const rec = records.participantsById[plan.participantId];
      if (!rec) {
        throw new BridgeError(
          "invalid_request",
          `Missing initial participant record for '${plan.participantId}'`,
          false,
        );
      }
      const sanitizedConfig = sanitizeParticipantConfig(plan.config);
      insertStmt.run(
        plan.participantId,
        runId,
        plan.roleId,
        plan.adapterId,
        JSON.stringify(plan.role),
        JSON.stringify(sanitizedConfig),
        rec.status,
        rec.turnsExecuted,
        rec.consecutiveFailures,
        i,
        rec.createdAt,
        rec.lastActiveAt || null,
      );
    }
  }

  get(id: string): PersistedParticipant | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM collaboration_participants WHERE id = ?").get(id) as any;
    return row ? mapParticipantRow(row) : null;
  }

  listByRun(runId: string): PersistedParticipant[] {
    const db = getDatabase();
    const rows = db
      .query(
        "SELECT * FROM collaboration_participants WHERE run_id = ? ORDER BY sequence_index ASC",
      )
      .all(runId) as any[];
    return rows.map(mapParticipantRow);
  }

  update(id: string, updates: Partial<ParticipantRecord>): void {
    const db = getDatabase();
    const current = this.get(id);
    if (!current) {
      throw new BridgeError("not_found", `Participant '${id}' not found`, false);
    }

    const merged = { ...current, ...updates };
    db.prepare(`
      UPDATE collaboration_participants SET
        status = ?, turns_executed = ?, consecutive_failures = ?, last_active_at = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.turnsExecuted,
      merged.consecutiveFailures,
      merged.lastActiveAt || null,
      id,
    );
  }
}
