import { getDatabase } from "./database";
import type {
  RoleBasedCollaborationRun,
  RoleBasedRunBudget,
  RunPolicy,
  ParticipantRecord,
} from "../core/collaboration-domain";
import { CollaborationParticipantStore } from "./collaboration-participant-store";
import { CollaborationTurnStore } from "./collaboration-turn-store";
import { BridgeError } from "../core/errors";

function safeParseJson<T>(json: string | null | undefined, fieldName: string, entityId: string): T {
  if (!json) {
    throw new BridgeError(
      "persistence_corruption",
      `Missing JSON for field '${fieldName}' in run '${entityId}'`,
      false,
    );
  }
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new BridgeError(
      "persistence_corruption",
      `Corrupt JSON in '${fieldName}' for run '${entityId}': ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

export class RoleBasedRunStore {
  constructor(
    private readonly participantStore = new CollaborationParticipantStore(),
    private readonly turnStore = new CollaborationTurnStore(),
  ) {}

  create(run: RoleBasedCollaborationRun): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO role_based_runs (
        id, session_id, objective, status, round, budget_json, policy_json,
        active_participant_id, final_summary, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.sessionId,
      run.objective,
      run.status,
      run.round,
      JSON.stringify(run.budget),
      JSON.stringify(run.policy),
      run.activeParticipantId || null,
      run.finalSummary || null,
      run.createdAt,
      run.startedAt || null,
      run.completedAt || null,
    );
  }

  get(id: string): RoleBasedCollaborationRun | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM role_based_runs WHERE id = ?").get(id) as any;
    if (!row) return null;
    return this.reconstructRun(row);
  }

  listBySession(sessionId: string): RoleBasedCollaborationRun[] {
    const db = getDatabase();
    const rows = db
      .query(
        "SELECT * FROM role_based_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(sessionId) as any[];
    return rows.map((row) => this.reconstructRun(row));
  }

  update(id: string, updates: Partial<RoleBasedCollaborationRun>): void {
    const db = getDatabase();
    const existing = db.query("SELECT * FROM role_based_runs WHERE id = ?").get(id) as any;
    if (!existing) {
      throw new BridgeError("not_found", `Role-based run '${id}' not found`, false);
    }

    const merged = {
      status: updates.status ?? existing.status,
      round: updates.round !== undefined ? updates.round : existing.round,
      activeParticipantId:
        updates.activeParticipantId !== undefined
          ? updates.activeParticipantId
          : existing.active_participant_id,
      finalSummary:
        updates.finalSummary !== undefined ? updates.finalSummary : existing.final_summary,
      completedAt:
        updates.completedAt !== undefined ? updates.completedAt : existing.completed_at,
    };

    db.prepare(`
      UPDATE role_based_runs SET
        status = ?, round = ?, active_participant_id = ?, final_summary = ?, completed_at = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.round,
      merged.activeParticipantId || null,
      merged.finalSummary || null,
      merged.completedAt || null,
      id,
    );
  }

  private reconstructRun(row: any): RoleBasedCollaborationRun {
    const budget = safeParseJson<RoleBasedRunBudget>(row.budget_json, "budget_json", row.id);
    const policy = safeParseJson<RunPolicy>(row.policy_json, "policy_json", row.id);

    const persistedParticipants = this.participantStore.listByRun(row.id);
    const participantIds: string[] = [];
    const participantsById: Record<string, ParticipantRecord> = {};

    for (const p of persistedParticipants) {
      participantIds.push(p.id);
      participantsById[p.id] = {
        id: p.id,
        roleId: p.roleId,
        adapterId: p.adapterId,
        status: p.status,
        turnsExecuted: p.turnsExecuted,
        consecutiveFailures: p.consecutiveFailures,
        createdAt: p.createdAt,
        lastActiveAt: p.lastActiveAt,
      };
    }

    const turns = this.turnStore.listByRun(row.id);
    const turnHistory = turns.map((t) => t.id);

    return {
      id: row.id,
      sessionId: row.session_id,
      objective: row.objective,
      status: row.status,
      round: row.round,
      budget,
      policy,
      participantIds,
      participantsById,
      activeParticipantId: row.active_participant_id || undefined,
      turnHistory,
      createdAt: row.created_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      finalSummary: row.final_summary || undefined,
    };
  }
}
