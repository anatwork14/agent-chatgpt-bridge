import { getDatabase } from "./database";
import type { CollaborationRun } from "../core/domain";

function rowToRun(row: any): CollaborationRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentAdapterId: row.agent_adapter_id,
    objective: row.objective,
    status: row.status,
    round: row.round,
    budget: JSON.parse(row.budget_json),
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    finalSummary: row.final_summary || undefined,
  };
}

export class RunStore {
  create(run: CollaborationRun) {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO runs (id, session_id, agent_adapter_id, objective, status, round, budget_json, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.sessionId,
      run.agentAdapterId,
      run.objective,
      run.status,
      run.round,
      JSON.stringify(run.budget),
      run.createdAt,
      run.startedAt || null
    );
  }

  get(id: string): CollaborationRun | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as any;
    return row ? rowToRun(row) : null;
  }

  list(): CollaborationRun[] {
    const db = getDatabase();
    const rows = db.query("SELECT * FROM runs ORDER BY created_at DESC, id DESC").all() as any[];
    return rows.map(rowToRun);
  }

  update(id: string, updates: Partial<CollaborationRun>) {
    const db = getDatabase();
    const current = this.get(id);
    if (!current) throw new Error("Run not found");
    const merged = { ...current, ...updates };

    db.prepare(`
      UPDATE runs SET
        status = ?, round = ?, completed_at = ?, final_summary = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.round,
      merged.completedAt || null,
      merged.finalSummary || null,
      id
    );
  }
}
