import type { AuditStore } from "../persistence/audit-store";
import { BridgeError } from "./errors";

export const P5_DAG_AUDIT_SCHEMA_VERSION = 1;

export const COLLABORATION_DAG_AUDIT_EVENT_TYPES = [
  "collaboration.dag.started",
  "collaboration.dag.validated",
  "collaboration.dag.node.ready",
  "collaboration.dag.node.started",
  "collaboration.dag.node.retrying",
  "collaboration.dag.node.completed",
  "collaboration.dag.node.failed",
  "collaboration.dag.node.cancelled",
  "collaboration.dag.node.skipped",
  "collaboration.dag.completed",
  "collaboration.dag.failed",
  "collaboration.dag.cancelled",
] as const;

export type CollaborationDagAuditEventType =
  (typeof COLLABORATION_DAG_AUDIT_EVENT_TYPES)[number];

interface BasePayload {
  readonly schemaVersion: 1;
}

export interface CollaborationDagAuditPayloadMap {
  "collaboration.dag.started": BasePayload & {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly participantCount: number;
    readonly maxParallelTurns: number;
    readonly failurePolicy: string;
  };
  "collaboration.dag.validated": BasePayload & {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly rootCount: number;
    readonly sinkCount: number;
  };
  "collaboration.dag.node.ready": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly declarationIndex: number;
    readonly dependencyCount: number;
  };
  "collaboration.dag.node.started": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
    readonly attempt: number;
    readonly turnIndex: number;
  };
  "collaboration.dag.node.retrying": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly errorCode: string;
  };
  "collaboration.dag.node.completed": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
    readonly attempt: number;
    readonly decisionType: "message" | "done";
    readonly durationMs: number;
  };
  "collaboration.dag.node.failed": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
    readonly attempt: number;
    readonly errorCode: string;
    readonly retryable: boolean;
  };
  "collaboration.dag.node.cancelled": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
    readonly attempt: number;
  };
  "collaboration.dag.node.skipped": BasePayload & {
    readonly nodeId: string;
    readonly participantId: string;
    readonly roleId: string;
  };
  "collaboration.dag.completed": BasePayload & {
    readonly nodeCount: number;
    readonly totalAttempts: number;
  };
  "collaboration.dag.failed": BasePayload & {
    readonly nodeCount: number;
    readonly totalAttempts: number;
    readonly failedNodeCount: number;
  };
  "collaboration.dag.cancelled": BasePayload & {
    readonly nodeCount: number;
    readonly totalAttempts: number;
    readonly cancelledNodeCount: number;
  };
}

const FORBIDDEN_KEY_PATTERN =
  /^(token|secret|password|authorization|cookie|api[_-]?key|oauth|credential|refresh[_-]?token|access[_-]?token|objective|prompt|transcript|content|message|summary|reason|cwd|command|env|environment|system[_-]?instructions?|model[_-]?output)$/i;

const CREDENTIAL_SUBSTRING =
  /(token|secret|password|authorization|cookie|api[_-]?key|oauth|credential)/i;

export function assertSafeCollaborationDagAuditPayload<T extends CollaborationDagAuditEventType>(
  eventType: T,
  payload: unknown,
): asserts payload is CollaborationDagAuditPayloadMap[T] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `DAG audit payload for '${eventType}' must be a non-null object`,
      false,
    );
  }

  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== P5_DAG_AUDIT_SCHEMA_VERSION) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `DAG audit payload for '${eventType}' must use schemaVersion ${P5_DAG_AUDIT_SCHEMA_VERSION}`,
      false,
    );
  }
  if (!COLLABORATION_DAG_AUDIT_EVENT_TYPES.includes(eventType)) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Unknown DAG audit event '${eventType}'`,
      false,
    );
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch (error) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `DAG audit payload is not serializable: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new BridgeError(
      "collaboration_audit_failed",
      "DAG audit payload exceeds 16 KiB",
      false,
    );
  }

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEY_PATTERN.test(key) || CREDENTIAL_SUBSTRING.test(key)) {
          throw new BridgeError(
            "collaboration_audit_failed",
            `Forbidden DAG audit key '${key}' at '${path}.${key}'`,
            false,
          );
        }
        walk(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === "string" && value.length > 4096) {
      throw new BridgeError(
        "collaboration_audit_failed",
        `DAG audit string exceeds 4096 characters at '${path}'`,
        false,
      );
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new BridgeError(
        "collaboration_audit_failed",
        `Unsupported DAG audit value at '${path}'`,
        false,
      );
    }
  };

  walk(payload, "payload");
}

export function emitCollaborationDagAuditEvent<T extends CollaborationDagAuditEventType>(
  auditStore: AuditStore,
  params: {
    readonly eventType: T;
    readonly runId: string;
    readonly sessionId: string;
    readonly turnId?: string;
    readonly createdAt?: string;
    readonly payload: CollaborationDagAuditPayloadMap[T];
  },
): void {
  assertSafeCollaborationDagAuditPayload(params.eventType, params.payload);
  try {
    auditStore.log({
      eventType: params.eventType,
      runId: params.runId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      createdAt: params.createdAt ?? new Date().toISOString(),
      payload: params.payload,
    });
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "collaboration_audit_failed",
      `Failed to write DAG audit event '${params.eventType}': ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}
