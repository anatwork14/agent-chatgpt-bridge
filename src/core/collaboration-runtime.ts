import type { ExternalAgentAdapter } from "./domain";
import type {
  RoleId,
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
} from "./collaboration-domain";
import type {
  ParticipantAssignmentPlan,
  InitialParticipantRecords,
} from "./participant-assignment";

/**
 * Memory-only runtime binding for an active collaboration participant.
 * Kept strictly in memory during turn execution; NEVER persisted or serialized.
 */
export interface ParticipantRuntime {
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly adapterId: string;
  adapter: ExternalAgentAdapter;
  readonly abortController?: AbortController;
  readonly recreateAdapter?: () => ExternalAgentAdapter;
}

/**
 * In-memory active role run control structure for P4 cancellation and tracking.
 * Strictly runtime-only; NEVER serialized or persisted.
 */
export interface ActiveRoleRunControl {
  readonly runId: string;
  readonly rootAbortController: AbortController;
  readonly persistence: RoleBasedRunPersistence;
  activeParticipantId?: string;
  activeTurnController?: AbortController;
  readonly cancelledParticipantIds: Set<string>;
  readonly cancelledParticipantReasons: Map<string, string>;
}

/**
 * Prepared collaboration participants container produced prior to execution.
 */
export interface PreparedRoleParticipants {
  readonly plans: readonly ParticipantAssignmentPlan[];
  readonly runtimes: readonly ParticipantRuntime[];
  readonly records: InitialParticipantRecords;
}

/**
 * Result of executing an in-memory role-based collaboration run.
 */
export interface RoleBasedExecutionResult {
  readonly run: RoleBasedCollaborationRun;
  readonly turns: readonly CollaborationTurnRecord[];
}

import type { RoleBasedRunPersistence } from "./collaboration-persistence";

/**
 * Configurable runtime options for executing a role-based run.
 */
export interface RoleBasedExecutionOptions {
  readonly signal?: AbortSignal;
  readonly clock?: () => string;
  readonly now?: () => number;
  readonly turnIdFactory?: () => string;
  readonly runIdFactory?: () => string;
  readonly messageIdFactory?: () => string;
}


import type {
  CollaborationDagBudget,
  CollaborationDagFailurePolicy,
  CollaborationDagNodeRecord,
} from "./collaboration-dag";
import type { CollaborationDagPersistence } from "./collaboration-dag-persistence";

export interface CollaborationDagExecutionOptions extends RoleBasedExecutionOptions {
  readonly budget?: Partial<CollaborationDagBudget>;
  readonly failurePolicy?: CollaborationDagFailurePolicy;
}

export interface ActiveCollaborationDagRunControl {
  readonly runId: string;
  readonly rootAbortController: AbortController;
  readonly persistence: CollaborationDagPersistence;
  attemptsStarted: number;
}

export interface CollaborationDagExecutionResult {
  readonly run: RoleBasedCollaborationRun;
  readonly nodes: readonly CollaborationDagNodeRecord[];
}


export interface CollaborationDagRecoveryReport {
  readonly examined: number;
  readonly pausedAtSafeBoundary: number;
  readonly interruptedNodesReconciled: number;
  readonly completedAtRecovery: number;
  readonly terminalAtRecovery: number;
  readonly failedRunIds: readonly string[];
}

export interface CollaborationDagResumeOptions {
  readonly allowReplayInterruptedNodes?: boolean;
  readonly signal?: AbortSignal;
  readonly clock?: () => string;
  readonly now?: () => number;
}
