import type { AuditEventData } from "../persistence/audit-store";
import type { BridgeIntegrationCorrelation } from "./integration-contract";
import {
  COLLABORATION_DAG_AUDIT_EVENT_TYPES,
  type CollaborationDagAuditEventType,
} from "./collaboration-dag-audit";

export const BRIDGE_INTEGRATION_EVENT_SCHEMA_VERSION = 1 as const;

export const BRIDGE_INTEGRATION_EVENT_TYPES = [
  "bridge.integration.dag_run.started",
  "bridge.integration.dag_run.validated",
  "bridge.integration.node.ready",
  "bridge.integration.node.started",
  "bridge.integration.node.retrying",
  "bridge.integration.node.completed",
  "bridge.integration.node.failed",
  "bridge.integration.node.cancelled",
  "bridge.integration.node.skipped",
  "bridge.integration.dag_run.completed",
  "bridge.integration.dag_run.failed",
  "bridge.integration.dag_run.cancelled",
  "bridge.integration.dag_run.recovered",
  "bridge.integration.dag_run.resumed",
] as const;

export type BridgeIntegrationEventType =
  (typeof BRIDGE_INTEGRATION_EVENT_TYPES)[number];

export interface BridgeIntegrationEventEnvelope {
  readonly schemaVersion: typeof BRIDGE_INTEGRATION_EVENT_SCHEMA_VERSION;
  readonly cursor: number;
  readonly type: BridgeIntegrationEventType;
  readonly runId: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly correlation?: BridgeIntegrationCorrelation;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

const TYPE_MAP: Readonly<Record<CollaborationDagAuditEventType, BridgeIntegrationEventType>> = {
  "collaboration.dag.started": "bridge.integration.dag_run.started",
  "collaboration.dag.validated": "bridge.integration.dag_run.validated",
  "collaboration.dag.node.ready": "bridge.integration.node.ready",
  "collaboration.dag.node.started": "bridge.integration.node.started",
  "collaboration.dag.node.retrying": "bridge.integration.node.retrying",
  "collaboration.dag.node.completed": "bridge.integration.node.completed",
  "collaboration.dag.node.failed": "bridge.integration.node.failed",
  "collaboration.dag.node.cancelled": "bridge.integration.node.cancelled",
  "collaboration.dag.node.skipped": "bridge.integration.node.skipped",
  "collaboration.dag.completed": "bridge.integration.dag_run.completed",
  "collaboration.dag.failed": "bridge.integration.dag_run.failed",
  "collaboration.dag.cancelled": "bridge.integration.dag_run.cancelled",
  "collaboration.dag.recovered": "bridge.integration.dag_run.recovered",
  "collaboration.dag.resumed": "bridge.integration.dag_run.resumed",
};

const PAYLOAD_FIELDS: Readonly<Record<CollaborationDagAuditEventType, readonly string[]>> = {
  "collaboration.dag.started": [
    "nodeCount",
    "edgeCount",
    "participantCount",
    "maxParallelTurns",
    "failurePolicy",
  ],
  "collaboration.dag.validated": ["nodeCount", "edgeCount", "rootCount", "sinkCount"],
  "collaboration.dag.node.ready": [
    "nodeId",
    "participantId",
    "declarationIndex",
    "dependencyCount",
  ],
  "collaboration.dag.node.started": [
    "nodeId",
    "participantId",
    "roleId",
    "attempt",
    "turnIndex",
  ],
  "collaboration.dag.node.retrying": [
    "nodeId",
    "participantId",
    "roleId",
    "attempt",
    "maxAttempts",
    "errorCode",
  ],
  "collaboration.dag.node.completed": [
    "nodeId",
    "participantId",
    "roleId",
    "attempt",
    "decisionType",
    "durationMs",
  ],
  "collaboration.dag.node.failed": [
    "nodeId",
    "participantId",
    "roleId",
    "attempt",
    "errorCode",
    "retryable",
  ],
  "collaboration.dag.node.cancelled": ["nodeId", "participantId", "roleId", "attempt"],
  "collaboration.dag.node.skipped": ["nodeId", "participantId", "roleId"],
  "collaboration.dag.completed": ["nodeCount", "totalAttempts"],
  "collaboration.dag.failed": ["nodeCount", "totalAttempts", "failedNodeCount"],
  "collaboration.dag.cancelled": ["nodeCount", "totalAttempts", "cancelledNodeCount"],
  "collaboration.dag.recovered": [
    "recoveryKind",
    "interruptedNodeCount",
    "outcomeStatus",
  ],
  "collaboration.dag.resumed": [
    "interruptedReplayCount",
    "completedNodeCount",
    "pendingNodeCount",
  ],
};

function isDagAuditEventType(value: string): value is CollaborationDagAuditEventType {
  return (COLLABORATION_DAG_AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

function projectedData(
  eventType: CollaborationDagAuditEventType,
  payload: unknown,
): Readonly<Record<string, string | number | boolean>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  const data: Record<string, string | number | boolean> = {};
  for (const field of PAYLOAD_FIELDS[eventType]) {
    const value = source[field];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const externalField =
        eventType === "collaboration.dag.recovered" && field === "outcomeStatus"
          ? "runStatus"
          : field;
      data[externalField] = value;
    }
  }
  return data;
}

export function projectBridgeIntegrationEvent(
  auditEvent: AuditEventData,
  correlation?: BridgeIntegrationCorrelation,
): BridgeIntegrationEventEnvelope | null {
  if (
    auditEvent.id === undefined ||
    !Number.isSafeInteger(auditEvent.id) ||
    auditEvent.id < 1 ||
    !auditEvent.runId ||
    !auditEvent.sessionId ||
    !isDagAuditEventType(auditEvent.eventType)
  ) {
    return null;
  }

  return {
    schemaVersion: BRIDGE_INTEGRATION_EVENT_SCHEMA_VERSION,
    cursor: auditEvent.id,
    type: TYPE_MAP[auditEvent.eventType],
    runId: auditEvent.runId,
    sessionId: auditEvent.sessionId,
    occurredAt: auditEvent.createdAt,
    correlation,
    data: projectedData(auditEvent.eventType, auditEvent.payload),
  };
}
