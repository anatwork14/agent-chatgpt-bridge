import type {
  RoleBasedCollaborationRun,
  RoleBasedCollaborationRunStatus,
} from "./collaboration-domain";
import type {
  CollaborationDagFailurePolicy,
  CollaborationDagNodeRecord,
  CollaborationDagNodeStatus,
  CollaborationDagRunMetadata,
} from "./collaboration-dag";

export const BRIDGE_INTEGRATION_SCHEMA_VERSION = 1 as const;

export interface BridgeIntegrationCapabilities {
  readonly schemaVersion: typeof BRIDGE_INTEGRATION_SCHEMA_VERSION;
  readonly service: "agent-chatgpt-bridge";
  readonly authority: {
    readonly collaboration: "bridge";
    readonly execution: "external";
    readonly coordination: "external";
  };
  readonly capabilities: {
    readonly dagRunProjection: boolean;
    readonly dagRunCancellation: boolean;
    readonly integrationEvents: boolean;
    readonly dagRunSubmission: boolean;
  };
}

export interface BridgeIntegrationDagNodeProjection {
  readonly id: string;
  readonly participantId: string;
  readonly roleId: string;
  readonly status: CollaborationDagNodeStatus;
  readonly declarationIndex: number;
  readonly attempt: number;
  readonly retryLimit: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

export interface BridgeIntegrationDagRunProjection {
  readonly schemaVersion: typeof BRIDGE_INTEGRATION_SCHEMA_VERSION;
  readonly kind: "collaboration_dag_run";
  readonly id: string;
  readonly sessionId: string;
  readonly status: RoleBasedCollaborationRunStatus;
  readonly failurePolicy: CollaborationDagFailurePolicy;
  readonly maxParallelTurns: number;
  readonly participantCount: number;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly nodes: readonly BridgeIntegrationDagNodeProjection[];
}

export function bridgeIntegrationCapabilities(
  enabled: {
    readonly dagRunProjection?: boolean;
    readonly dagRunCancellation?: boolean;
    readonly integrationEvents?: boolean;
    readonly dagRunSubmission?: boolean;
  } = {},
): BridgeIntegrationCapabilities {
  return {
    schemaVersion: BRIDGE_INTEGRATION_SCHEMA_VERSION,
    service: "agent-chatgpt-bridge",
    authority: {
      collaboration: "bridge",
      execution: "external",
      coordination: "external",
    },
    capabilities: {
      dagRunProjection: enabled.dagRunProjection ?? true,
      dagRunCancellation: enabled.dagRunCancellation ?? true,
      integrationEvents: enabled.integrationEvents ?? false,
      dagRunSubmission: enabled.dagRunSubmission ?? false,
    },
  };
}

export function createBridgeIntegrationDagRunProjection(params: {
  readonly run: RoleBasedCollaborationRun;
  readonly metadata: CollaborationDagRunMetadata;
  readonly nodes: readonly CollaborationDagNodeRecord[];
}): BridgeIntegrationDagRunProjection {
  const nodes = [...params.nodes]
    .sort((a, b) => a.declarationIndex - b.declarationIndex || a.id.localeCompare(b.id))
    .map(node => ({
      id: node.id,
      participantId: node.participantId,
      roleId: node.roleId,
      status: node.status,
      declarationIndex: node.declarationIndex,
      attempt: node.attempt,
      retryLimit: node.retryLimit,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      error: node.error
        ? {
            code: node.error.code,
            retryable: node.error.retryable,
          }
        : undefined,
    }));

  return {
    schemaVersion: BRIDGE_INTEGRATION_SCHEMA_VERSION,
    kind: "collaboration_dag_run",
    id: params.run.id,
    sessionId: params.run.sessionId,
    status: params.run.status,
    failurePolicy: params.metadata.failurePolicy,
    maxParallelTurns: params.metadata.maxParallelTurns,
    participantCount: params.run.participantIds.length,
    nodeCount: nodes.length,
    createdAt: params.run.createdAt,
    startedAt: params.run.startedAt,
    completedAt: params.run.completedAt,
    nodes,
  };
}
