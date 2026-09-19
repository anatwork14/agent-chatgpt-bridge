import { getDatabase } from "./database";
import type { BridgeIntegrationCorrelation } from "../core/integration-contract";

export class IntegrationCorrelationStore {
  create(runId: string, correlation: BridgeIntegrationCorrelation, createdAt: string): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO collaboration_integration_correlations (
        run_id,
        schema_version,
        arc_project_id,
        arc_task_id,
        arc_session_id,
        company_workflow_id,
        company_step_id,
        company_run_id,
        external_trace_id,
        created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      correlation.arcProjectId ?? null,
      correlation.arcTaskId ?? null,
      correlation.arcSessionId ?? null,
      correlation.companyWorkflowId ?? null,
      correlation.companyStepId ?? null,
      correlation.companyRunId ?? null,
      correlation.externalTraceId ?? null,
      createdAt,
    );
  }

  get(runId: string): BridgeIntegrationCorrelation | undefined {
    const db = getDatabase();
    const row = db.query(`
      SELECT *
      FROM collaboration_integration_correlations
      WHERE run_id = ?
    `).get(runId) as any;

    if (!row) return undefined;
    return {
      arcProjectId: row.arc_project_id ?? undefined,
      arcTaskId: row.arc_task_id ?? undefined,
      arcSessionId: row.arc_session_id ?? undefined,
      companyWorkflowId: row.company_workflow_id ?? undefined,
      companyStepId: row.company_step_id ?? undefined,
      companyRunId: row.company_run_id ?? undefined,
      externalTraceId: row.external_trace_id ?? undefined,
    };
  }
}
