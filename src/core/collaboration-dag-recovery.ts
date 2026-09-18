import {
  type CollaborationDagBudget,
  type CollaborationDagExecutionPlan,
  type CollaborationDagNodeRecord,
  type CollaborationDagNodeStatus,
  type CollaborationDagRunMetadata,
  type PersistedCollaborationDagInput,
} from "./collaboration-dag";
import { planCollaborationDag } from "./collaboration-dag-validation";
import type { RoleBasedCollaborationRun } from "./collaboration-domain";
import type { CollaborationMessageRecord } from "./collaboration-transcript";
import { BridgeError } from "./errors";

const VALID_NODE_STATUSES = new Set<CollaborationDagNodeStatus>([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface CollaborationDagPersistedState {
  readonly plan: CollaborationDagExecutionPlan;
  readonly statusesByNode: Readonly<Record<string, CollaborationDagNodeStatus>>;
  readonly interruptedNodeIds: readonly string[];
  readonly completedTerminalNodeIds: readonly string[];
  readonly totalAttemptsStarted: number;
}

/**
 * Validates persisted P5 state without spawning adapters or mutating storage.
 * This is the canonical fail-closed gate shared by startup recovery and explicit resume.
 */
export function deriveCollaborationDagPersistedState(params: {
  readonly run: RoleBasedCollaborationRun;
  readonly metadata: CollaborationDagRunMetadata;
  readonly nodes: readonly CollaborationDagNodeRecord[];
  readonly inputs: readonly PersistedCollaborationDagInput[];
  readonly messagesByNode: Readonly<Record<string, CollaborationMessageRecord>>;
}): CollaborationDagPersistedState {
  const { run, metadata, nodes, inputs, messagesByNode } = params;

  if (metadata.runId !== run.id) {
    throw new BridgeError(
      "persistence_corruption",
      `DAG metadata runId '${metadata.runId}' does not match run '${run.id}'`,
      false,
    );
  }
  if (metadata.maxParallelTurns !== run.budget.maxParallelTurns) {
    throw new BridgeError(
      "persistence_corruption",
      `DAG maxParallelTurns mismatch for run '${run.id}'`,
      false,
    );
  }

  const participantIds = new Set(run.participantIds);
  const plan = planCollaborationDag(metadata.graph, {
    knownParticipantIds: participantIds,
    budget: run.budget as CollaborationDagBudget,
  });

  if (nodes.length !== plan.nodeIds.length) {
    throw new BridgeError(
      "persistence_corruption",
      `Persisted DAG node count mismatch for run '${run.id}'`,
      false,
    );
  }

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const statusesByNode: Record<string, CollaborationDagNodeStatus> = {};
  const interruptedNodeIds: string[] = [];
  const completedTerminalNodeIds: string[] = [];
  let totalAttemptsStarted = 0;

  for (const nodeId of plan.nodeIds) {
    const planned = plan.nodesById[nodeId]!;
    const persisted = nodeById.get(nodeId);
    if (!persisted) {
      throw new BridgeError(
        "persistence_corruption",
        `Missing persisted DAG node '${nodeId}' for run '${run.id}'`,
        false,
      );
    }
    if (
      persisted.runId !== run.id ||
      persisted.participantId !== planned.participantId ||
      persisted.declarationIndex !== planned.declarationIndex ||
      persisted.retryLimit !== planned.retryLimit ||
      persisted.timeoutMs !== planned.timeoutMs
    ) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG node '${nodeId}' does not match graph definition`,
        false,
      );
    }

    const participant = run.participantsById[persisted.participantId];
    if (!participant || participant.roleId !== persisted.roleId) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG node '${nodeId}' has invalid participant/role provenance`,
        false,
      );
    }
    if (!VALID_NODE_STATUSES.has(persisted.status)) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG node '${nodeId}' has invalid status '${String(persisted.status)}'`,
        false,
      );
    }
    if (!Number.isInteger(persisted.attempt) || persisted.attempt < 0) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG node '${nodeId}' has invalid attempt counter`,
        false,
      );
    }
    if (persisted.attempt > persisted.retryLimit + 1) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG node '${nodeId}' exceeded its bounded attempt limit`,
        false,
      );
    }

    if (persisted.status === "pending" && persisted.attempt !== 0) {
      throw new BridgeError(
        "persistence_corruption",
        `Pending DAG node '${nodeId}' cannot have started attempts`,
        false,
      );
    }
    if (persisted.status === "running") {
      if (persisted.attempt < 1 || persisted.outputMessageId) {
        throw new BridgeError(
          "persistence_corruption",
          `Running DAG node '${nodeId}' has invalid attempt/output state`,
          false,
        );
      }
      interruptedNodeIds.push(nodeId);
    }

    const output = messagesByNode[nodeId];
    if (persisted.status === "completed") {
      if (persisted.attempt < 1 || !persisted.outputMessageId || !output) {
        throw new BridgeError(
          "persistence_corruption",
          `Completed DAG node '${nodeId}' is missing its canonical output`,
          false,
        );
      }
      if (
        output.id !== persisted.outputMessageId ||
        output.runId !== run.id ||
        output.senderParticipantId !== persisted.participantId ||
        output.senderRoleId !== persisted.roleId ||
        output.sequenceIndex !== persisted.declarationIndex
      ) {
        throw new BridgeError(
          "persistence_corruption",
          `Completed DAG node '${nodeId}' output provenance is inconsistent`,
          false,
        );
      }
      if (planned.terminal) completedTerminalNodeIds.push(nodeId);
    } else if (persisted.outputMessageId || output) {
      throw new BridgeError(
        "persistence_corruption",
        `Non-completed DAG node '${nodeId}' cannot own canonical output`,
        false,
      );
    }

    statusesByNode[nodeId] = persisted.status;
    totalAttemptsStarted += persisted.attempt;
  }

  for (const persisted of nodes) {
    if (!plan.nodesById[persisted.id]) {
      throw new BridgeError(
        "persistence_corruption",
        `Unexpected persisted DAG node '${persisted.id}' for run '${run.id}'`,
        false,
      );
    }
  }

  const inputKeys = new Set<string>();
  for (const input of inputs) {
    const node = nodeById.get(input.nodeId);
    const planned = plan.nodesById[input.nodeId];
    if (!node || !planned || input.runId !== run.id) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG input references an unknown node/run ('${input.nodeId}')`,
        false,
      );
    }
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > node.attempt) {
      throw new BridgeError(
        "persistence_corruption",
        `Persisted DAG input for '${input.nodeId}' has invalid attempt '${input.attempt}'`,
        false,
      );
    }
    const key = `${input.nodeId}:${input.attempt}`;
    if (inputKeys.has(key)) {
      throw new BridgeError(
        "persistence_corruption",
        `Duplicate DAG input provenance '${key}'`,
        false,
      );
    }
    inputKeys.add(key);

    if (!sameStrings(input.predecessorNodeIds, planned.dependsOn)) {
      throw new BridgeError(
        "persistence_corruption",
        `DAG input predecessor order mismatch for '${input.nodeId}'`,
        false,
      );
    }
    const expectedMessageIds = planned.dependsOn.map(depId => {
      const message = messagesByNode[depId];
      if (!message) {
        throw new BridgeError(
          "persistence_corruption",
          `DAG input for '${input.nodeId}' references predecessor '${depId}' without canonical output`,
          false,
        );
      }
      return message.id;
    });
    if (!sameStrings(input.predecessorMessageIds, expectedMessageIds)) {
      throw new BridgeError(
        "persistence_corruption",
        `DAG input predecessor message provenance mismatch for '${input.nodeId}'`,
        false,
      );
    }
  }

  for (const node of nodes) {
    if (node.status === "completed" && !inputKeys.has(`${node.id}:${node.attempt}`)) {
      throw new BridgeError(
        "persistence_corruption",
        `Completed DAG node '${node.id}' is missing final-attempt input provenance`,
        false,
      );
    }
    if (
      node.status === "ready" &&
      node.attempt > 0 &&
      node.error?.code !== "daemon_restarted" &&
      !inputKeys.has(`${node.id}:${node.attempt}`)
    ) {
      throw new BridgeError(
        "persistence_corruption",
        `Retried DAG node '${node.id}' is missing prior-attempt provenance`,
        false,
      );
    }
  }

  if (totalAttemptsStarted > run.budget.maxTurns) {
    throw new BridgeError(
      "persistence_corruption",
      `DAG run '${run.id}' persisted more attempts than maxTurns`,
      false,
    );
  }

  return {
    plan,
    statusesByNode,
    interruptedNodeIds,
    completedTerminalNodeIds,
    totalAttemptsStarted,
  };
}
