import type { RoleId, RoleBasedRunBudget } from "./collaboration-domain";

/**
 * P5 adds bounded static DAG execution on top of the released P4 role/participant model.
 * These types are intentionally serializable. Runtime handles remain in RunController.
 */
export type CollaborationDagNodeId = string;

export const P5_DAG_NODE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

export const P5_LIMITS = {
  maxNodes: 64,
  maxEdges: 256,
  maxParallelTurns: 4,
  maxNodeInstructionChars: 32_000,
} as const;

export interface CollaborationDagBudget
  extends Omit<RoleBasedRunBudget, "maxParallelTurns"> {
  readonly maxParallelTurns: number;
}

export const P5_DEFAULT_BUDGET: CollaborationDagBudget = {
  maxTurns: 30,
  maxParticipants: 5,
  maxParallelTurns: 2,
  maxRetriesPerParticipant: 2,
  maxWallClockMs: 60 * 60 * 1000,
};

export type CollaborationDagFailurePolicy = "fail_fast" | "skip_dependents";

export interface CollaborationDagNodeDefinition {
  readonly id: CollaborationDagNodeId;
  readonly participantId: string;
  readonly instruction: string;
  readonly dependsOn: readonly CollaborationDagNodeId[];
  readonly terminal?: boolean;
  readonly retryLimit?: number;
  readonly timeoutMs?: number;
}

export interface CollaborationDagDefinition {
  readonly version: 1;
  readonly nodes: readonly CollaborationDagNodeDefinition[];
}

export type CollaborationDagNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export const COLLABORATION_DAG_NODE_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type CollaborationDagNodeTerminalStatus =
  (typeof COLLABORATION_DAG_NODE_TERMINAL_STATUSES)[number];

export function isCollaborationDagNodeTerminalStatus(
  status: CollaborationDagNodeStatus,
): status is CollaborationDagNodeTerminalStatus {
  return (COLLABORATION_DAG_NODE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface CollaborationDagNodeRecord {
  readonly id: CollaborationDagNodeId;
  readonly runId: string;
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly status: CollaborationDagNodeStatus;
  readonly declarationIndex: number;
  readonly attempt: number;
  readonly retryLimit: number;
  readonly timeoutMs?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly outputMessageId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface CollaborationDagInputProvenance {
  readonly nodeId: CollaborationDagNodeId;
  readonly objectiveIncluded: boolean;
  readonly predecessorMessageIds: readonly string[];
  readonly predecessorNodeIds: readonly CollaborationDagNodeId[];
  readonly assembledAt: string;
}

export interface CollaborationDagPlannedNode {
  readonly id: CollaborationDagNodeId;
  readonly participantId: string;
  readonly instruction: string;
  readonly dependsOn: readonly CollaborationDagNodeId[];
  readonly dependents: readonly CollaborationDagNodeId[];
  readonly declarationIndex: number;
  readonly indegree: number;
  readonly topologicalLevel: number;
  readonly terminal: boolean;
  readonly retryLimit: number;
  readonly timeoutMs?: number;
}

export interface CollaborationDagExecutionPlan {
  readonly version: 1;
  readonly edgeCount: number;
  readonly nodeIds: readonly CollaborationDagNodeId[];
  readonly topologicalOrder: readonly CollaborationDagNodeId[];
  readonly rootNodeIds: readonly CollaborationDagNodeId[];
  readonly sinkNodeIds: readonly CollaborationDagNodeId[];
  readonly nodesById: Readonly<Record<CollaborationDagNodeId, CollaborationDagPlannedNode>>;
}
