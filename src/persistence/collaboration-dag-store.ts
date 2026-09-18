import { getDatabase } from "./database";
import {
  isCollaborationDagNodeTerminalStatus,
  isValidCollaborationDagNodeTransition,
  type CollaborationDagDefinition,
  type CollaborationDagExecutionPlan,
  type CollaborationDagFailurePolicy,
  type CollaborationDagNodeRecord,
  type CollaborationDagNodeStatus,
  type CollaborationDagRunMetadata,
  type PersistedCollaborationDagInput,
} from "../core/collaboration-dag";
import type { RoleId } from "../core/collaboration-domain";
import { BridgeError } from "../core/errors";

function safeParseJson<T>(
  raw: string | null | undefined,
  field: string,
  entity: string,
): T {
  if (!raw) {
    throw new BridgeError(
      "persistence_corruption",
      `Missing JSON field '${field}' for '${entity}'`,
      false,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new BridgeError(
      "persistence_corruption",
      `Corrupt JSON field '${field}' for '${entity}': ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function mapNodeRow(row: any): CollaborationDagNodeRecord {
  return {
    id: row.id,
    runId: row.run_id,
    participantId: row.participant_id,
    roleId: row.role_id,
    status: row.status,
    declarationIndex: row.declaration_index,
    attempt: row.attempt,
    retryLimit: row.retry_limit,
    timeoutMs: row.timeout_ms ?? undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    outputMessageId: row.output_message_id || undefined,
    error: row.error_json
      ? safeParseJson(row.error_json, "error_json", `${row.run_id}/${row.id}`)
      : undefined,
  };
}

export interface CollaborationDagNodePatch {
  readonly status?: CollaborationDagNodeStatus;
  readonly attempt?: number;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly outputMessageId?: string | null;
  readonly error?: CollaborationDagNodeRecord["error"] | null;
}

export class CollaborationDagStore {
  create(params: {
    readonly runId: string;
    readonly graph: CollaborationDagDefinition;
    readonly plan: CollaborationDagExecutionPlan;
    readonly failurePolicy: CollaborationDagFailurePolicy;
    readonly maxParallelTurns: number;
    readonly roleIdByParticipant: Readonly<Record<string, RoleId>>;
  }): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO collaboration_dag_runs (
        run_id, graph_version, failure_policy, graph_json, max_parallel_turns
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      params.runId,
      params.graph.version,
      params.failurePolicy,
      JSON.stringify(params.graph),
      params.maxParallelTurns,
    );

    const insertNode = db.prepare(`
      INSERT INTO collaboration_dag_nodes (
        run_id, id, participant_id, role_id, declaration_index, instruction_text,
        status, attempt, retry_limit, timeout_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `);

    for (const nodeId of params.plan.nodeIds) {
      const node = params.plan.nodesById[nodeId]!;
      const roleId = params.roleIdByParticipant[node.participantId];
      if (!roleId) {
        throw new BridgeError(
          "invalid_collaboration_dag",
          `No persisted role binding for DAG participant '${node.participantId}'`,
          false,
        );
      }
      insertNode.run(
        params.runId,
        node.id,
        node.participantId,
        roleId,
        node.declarationIndex,
        node.instruction,
        node.retryLimit,
        node.timeoutMs ?? null,
      );
    }

    const insertEdge = db.prepare(`
      INSERT INTO collaboration_dag_edges (
        run_id, predecessor_node_id, successor_node_id, dependency_order
      ) VALUES (?, ?, ?, ?)
    `);
    for (const nodeId of params.plan.nodeIds) {
      const node = params.plan.nodesById[nodeId]!;
      node.dependsOn.forEach((predecessorId, dependencyOrder) => {
        insertEdge.run(params.runId, predecessorId, node.id, dependencyOrder);
      });
    }
  }

  getMetadata(runId: string): CollaborationDagRunMetadata | null {
    const db = getDatabase();
    const row = db.query(
      "SELECT * FROM collaboration_dag_runs WHERE run_id = ?",
    ).get(runId) as any;
    if (!row) return null;
    const graph = safeParseJson<CollaborationDagDefinition>(
      row.graph_json,
      "graph_json",
      runId,
    );
    if (graph.version !== row.graph_version) {
      throw new BridgeError(
        "persistence_corruption",
        `DAG graph version mismatch for run '${runId}'`,
        false,
      );
    }
    return {
      runId,
      graph,
      failurePolicy: row.failure_policy,
      maxParallelTurns: row.max_parallel_turns,
    };
  }

  getNode(runId: string, nodeId: string): CollaborationDagNodeRecord | null {
    const db = getDatabase();
    const row = db.query(
      "SELECT * FROM collaboration_dag_nodes WHERE run_id = ? AND id = ?",
    ).get(runId, nodeId) as any;
    return row ? mapNodeRow(row) : null;
  }

  listNodes(runId: string): CollaborationDagNodeRecord[] {
    const db = getDatabase();
    const rows = db.query(`
      SELECT * FROM collaboration_dag_nodes
      WHERE run_id = ?
      ORDER BY declaration_index ASC, id ASC
    `).all(runId) as any[];
    return rows.map(mapNodeRow);
  }

  updateNode(runId: string, nodeId: string, patch: CollaborationDagNodePatch): void {
    const db = getDatabase();
    const existing = this.getNode(runId, nodeId);
    if (!existing) {
      throw new BridgeError(
        "not_found",
        `DAG node '${nodeId}' not found in run '${runId}'`,
        false,
      );
    }

    const nextStatus = patch.status ?? existing.status;
    if (!isValidCollaborationDagNodeTransition(existing.status, nextStatus)) {
      throw new BridgeError(
        "invalid_state_transition",
        `Invalid DAG node transition '${existing.status}' -> '${nextStatus}' for '${nodeId}'`,
        false,
      );
    }

    const next = {
      status: nextStatus,
      attempt: patch.attempt ?? existing.attempt,
      startedAt:
        patch.startedAt === null
          ? undefined
          : patch.startedAt !== undefined
            ? patch.startedAt
            : existing.startedAt,
      completedAt:
        patch.completedAt === null
          ? undefined
          : patch.completedAt !== undefined
            ? patch.completedAt
            : existing.completedAt,
      outputMessageId:
        patch.outputMessageId === null
          ? undefined
          : patch.outputMessageId !== undefined
            ? patch.outputMessageId
            : existing.outputMessageId,
      error:
        patch.error === null
          ? undefined
          : patch.error !== undefined
            ? patch.error
            : existing.error,
    };

    if (isCollaborationDagNodeTerminalStatus(existing.status)) {
      const changed =
        next.status !== existing.status ||
        next.attempt !== existing.attempt ||
        next.startedAt !== existing.startedAt ||
        next.completedAt !== existing.completedAt ||
        next.outputMessageId !== existing.outputMessageId ||
        JSON.stringify(next.error) !== JSON.stringify(existing.error);
      if (changed) {
        throw new BridgeError(
          "invalid_state_transition",
          `Cannot mutate terminal DAG node '${nodeId}' (status: '${existing.status}')`,
          false,
        );
      }
      return;
    }

    db.prepare(`
      UPDATE collaboration_dag_nodes SET
        status = ?,
        attempt = ?,
        started_at = ?,
        completed_at = ?,
        output_message_id = ?,
        error_json = ?
      WHERE run_id = ? AND id = ?
    `).run(
      next.status,
      next.attempt,
      next.startedAt ?? null,
      next.completedAt ?? null,
      next.outputMessageId ?? null,
      next.error ? JSON.stringify(next.error) : null,
      runId,
      nodeId,
    );
  }

  insertInput(input: PersistedCollaborationDagInput): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO collaboration_dag_inputs (
        run_id, node_id, attempt, turn_id, objective_included,
        predecessor_node_ids_json, predecessor_message_ids_json, assembled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.nodeId,
      input.attempt,
      input.turnId,
      input.objectiveIncluded ? 1 : 0,
      JSON.stringify(input.predecessorNodeIds),
      JSON.stringify(input.predecessorMessageIds),
      input.assembledAt,
    );
  }

  listInputs(runId: string, nodeId?: string): PersistedCollaborationDagInput[] {
    const db = getDatabase();
    const rows = nodeId
      ? db.query(`
          SELECT * FROM collaboration_dag_inputs
          WHERE run_id = ? AND node_id = ?
          ORDER BY attempt ASC
        `).all(runId, nodeId) as any[]
      : db.query(`
          SELECT * FROM collaboration_dag_inputs
          WHERE run_id = ?
          ORDER BY node_id ASC, attempt ASC
        `).all(runId) as any[];

    return rows.map(row => ({
      runId: row.run_id,
      nodeId: row.node_id,
      attempt: row.attempt,
      turnId: row.turn_id,
      objectiveIncluded: row.objective_included === 1,
      predecessorNodeIds: safeParseJson(
        row.predecessor_node_ids_json,
        "predecessor_node_ids_json",
        `${row.run_id}/${row.node_id}/${row.attempt}`,
      ),
      predecessorMessageIds: safeParseJson(
        row.predecessor_message_ids_json,
        "predecessor_message_ids_json",
        `${row.run_id}/${row.node_id}/${row.attempt}`,
      ),
      assembledAt: row.assembled_at,
    }));
  }
}
