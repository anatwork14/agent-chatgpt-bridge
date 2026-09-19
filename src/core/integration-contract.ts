import { BridgeError } from "./errors";
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
export const BRIDGE_INTEGRATION_CORRELATION_MAX_LENGTH = 128;

export interface BridgeIntegrationCorrelation {
  readonly arcProjectId?: string;
  readonly arcTaskId?: string;
  readonly arcSessionId?: string;
  readonly companyWorkflowId?: string;
  readonly companyStepId?: string;
  readonly companyRunId?: string;
  readonly externalTraceId?: string;
}

const CORRELATION_FIELDS = [
  "arcProjectId",
  "arcTaskId",
  "arcSessionId",
  "companyWorkflowId",
  "companyStepId",
  "companyRunId",
  "externalTraceId",
] as const satisfies readonly (keyof BridgeIntegrationCorrelation)[];

function normalizeCorrelationId(field: string, value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > BRIDGE_INTEGRATION_CORRELATION_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/.test(normalized)
  ) {
    throw new BridgeError(
      "invalid_request",
      `${field} must be a 1-${BRIDGE_INTEGRATION_CORRELATION_MAX_LENGTH} character opaque identifier using only safe identifier characters`,
      false,
    );
  }
  return normalized;
}

export function normalizeBridgeIntegrationCorrelation(
  correlation: BridgeIntegrationCorrelation | undefined,
): BridgeIntegrationCorrelation | undefined {
  if (!correlation) return undefined;
  const normalized: Record<string, string> = {};
  for (const field of CORRELATION_FIELDS) {
    const value = correlation[field];
    if (value === undefined) continue;
    normalized[field] = normalizeCorrelationId(field, value);
  }
  return Object.keys(normalized).length > 0
    ? normalized as BridgeIntegrationCorrelation
    : undefined;
}

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
  readonly correlation?: BridgeIntegrationCorrelation;
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
  readonly correlation?: BridgeIntegrationCorrelation;
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
    correlation: params.correlation,
    nodes,
  };
}
