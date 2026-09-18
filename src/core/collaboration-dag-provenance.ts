import type {
  CollaborationDagExecutionPlan,
  CollaborationDagInputProvenance,
} from "./collaboration-dag";
import {
  assertCollaborationMessageIntegrity,
  collaborationMessagesToPriorTurns,
  type CollaborationMessageRecord,
} from "./collaboration-transcript";
import type { PriorCollaborationTurn } from "./domain";
import { BridgeError } from "./errors";

export interface AssembledCollaborationDagInput {
  readonly provenance: CollaborationDagInputProvenance;
  readonly predecessorMessages: readonly CollaborationMessageRecord[];
  readonly priorTurns: readonly PriorCollaborationTurn[];
}

/**
 * Deterministically assembles only the predecessor outputs declared by a node.
 * Unrelated sibling messages are ignored even if present in the lookup map.
 */
export function assembleCollaborationDagInput(params: {
  readonly runId: string;
  readonly nodeId: string;
  readonly plan: CollaborationDagExecutionPlan;
  readonly messagesByNodeId: Readonly<Record<string, CollaborationMessageRecord | undefined>>;
  readonly objectiveIncluded?: boolean;
  readonly assembledAt: string;
}): AssembledCollaborationDagInput {
  const node = params.plan.nodesById[params.nodeId];
  if (!node) {
    throw new BridgeError(
      "collaboration_dag_node_not_found",
      `DAG node '${params.nodeId}' is not present in the execution plan`,
      false,
    );
  }

  const predecessorMessages: CollaborationMessageRecord[] = [];
  for (const predecessorNodeId of node.dependsOn) {
    const message = params.messagesByNodeId[predecessorNodeId];
    if (!message) {
      throw new BridgeError(
        "collaboration_dag_input_missing",
        `Missing canonical output for predecessor node '${predecessorNodeId}' required by '${params.nodeId}'`,
        false,
      );
    }
    if (message.runId !== params.runId) {
      throw new BridgeError(
        "collaboration_dag_input_run_mismatch",
        `Predecessor message '${message.id}' belongs to a different run`,
        false,
      );
    }
    assertCollaborationMessageIntegrity(message);
    predecessorMessages.push(message);
  }

  return {
    provenance: {
      nodeId: params.nodeId,
      objectiveIncluded: params.objectiveIncluded !== false,
      predecessorNodeIds: [...node.dependsOn],
      predecessorMessageIds: predecessorMessages.map(message => message.id),
      assembledAt: params.assembledAt,
    },
    predecessorMessages,
    priorTurns: collaborationMessagesToPriorTurns(predecessorMessages),
  };
}
