import { BridgeError } from "./errors";
import type { AuditStore } from "../persistence/audit-store";
import type {
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
} from "./collaboration-domain";

export const P4_AUDIT_SCHEMA_VERSION = 1;

export const COLLABORATION_AUDIT_EVENT_TYPES = [
  "collaboration.started",
  "participant.assigned",
  "participant.turn.started",
  "participant.turn.completed",
  "participant.turn.failed",
  "participant.turn.cancelled",
  "participant.retry.scheduled",
  "participant.runtime.recreated",
  "collaboration.paused",
  "collaboration.cancel.requested",
  "participant.cancel.requested",
  "collaboration.recovered",
  "collaboration.replay.acknowledged",
  "collaboration.resumed",
  "collaboration.completed",
  "collaboration.failed",
  "collaboration.cancelled",
  "collaboration.timed_out",
  "collaboration.budget_exhausted",
] as const;

export type CollaborationAuditEventType =
  (typeof COLLABORATION_AUDIT_EVENT_TYPES)[number];

export interface CollaborationAuditPayloadMap {
  "collaboration.started": {
    readonly schemaVersion: 1;
    readonly participantCount: number;
    readonly roleSequence: readonly string[];
    readonly loopMode: string;
    readonly budget: {
      readonly maxTurns: number;
      readonly maxParticipants: number;
      readonly maxParallelTurns: 1;
      readonly maxRetriesPerParticipant: number;
      readonly maxWallClockMs: number;
    };
  };

  "participant.assigned": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly adapterId: string;
    readonly sequenceIndex: number;
  };

  "participant.turn.started": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly adapterId: string;
    readonly round: number;
    readonly turnIndex: number;
    readonly attemptOrdinal: number;
  };

  "participant.turn.completed": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly round: number;
    readonly turnIndex: number;
    readonly decisionType: "message" | "done" | "pause";
    readonly durationMs?: number;
  };

  "participant.turn.failed": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly round: number;
    readonly turnIndex: number;
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly durationMs?: number;
  };

  "participant.turn.cancelled": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly round: number;
    readonly turnIndex: number;
    readonly cancellationScope: "run" | "participant" | "workflow";
  };

  "participant.retry.scheduled": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly retryOrdinal: number;
    readonly maxRetries: number;
    readonly nextTurnIndex: number;
    readonly recreateRuntime: boolean;
  };

  "participant.runtime.recreated": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly adapterId: string;
    readonly causeCode: string;
  };

  "collaboration.paused": {
    readonly schemaVersion: 1;
    readonly round: number;
    readonly turnIndex: number;
    readonly participantId?: string;
    readonly roleId?: string;
    readonly reasonPresent: boolean;
  };

  "collaboration.cancel.requested": {
    readonly schemaVersion: 1;
    readonly activeParticipantId?: string;
    readonly reasonPresent: boolean;
  };

  "participant.cancel.requested": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId?: string;
    readonly wasActive: boolean;
    readonly reasonPresent: boolean;
  };

  "collaboration.recovered": {
    readonly schemaVersion: 1;
    readonly recoveryKind: "safe_boundary" | "interrupted_turn";
    readonly outcomeStatus: string;
    readonly participantId?: string;
    readonly turnIndex?: number;
    readonly syntheticTurn: boolean;
  };

  "collaboration.replay.acknowledged": {
    readonly schemaVersion: 1;
    readonly participantId: string;
    readonly roleId: string;
    readonly interruptedTurnIndex: number;
  };

  "collaboration.resumed": {
    readonly schemaVersion: 1;
    readonly round: number;
    readonly sequenceIndex: number;
    readonly nextTurnIndex: number;
    readonly participantId: string;
    readonly roleId: string;
    readonly replayAcknowledged: boolean;
  };

  "collaboration.completed": {
    readonly schemaVersion: 1;
    readonly round: number;
    readonly totalTurns: number;
  };

  "collaboration.failed": {
    readonly schemaVersion: 1;
    readonly round: number;
    readonly totalTurns: number;
    readonly errorCode?: string;
    readonly failureCategory?: string;
    readonly participantId?: string;
    readonly roleId?: string;
  };

  "collaboration.cancelled": {
    readonly schemaVersion: 1;
    readonly round: number;
    readonly totalTurns: number;
  };

  "collaboration.timed_out": {
    readonly schemaVersion: 1;
    readonly totalTurns: number;
    readonly maxWallClockMs: number;
  };

  "collaboration.budget_exhausted": {
    readonly schemaVersion: 1;
    readonly totalTurns: number;
    readonly maxTurns: number;
  };
}

const FORBIDDEN_KEY_PATTERN =
  /^(token|secret|password|authorization|cookie|api[_-]?key|oauth|credential|refresh[_-]?token|access[_-]?token|objective|system[_-]?instructions?|model[_-]?output|transcript|prompt|cwd|command|final[_-]?summary|summary|reason|message|error[_-]?message|critique|content|input[_-]?summary|arguments|args|env|environment)$/i;

const FORBIDDEN_CREDENTIAL_SUBSTRING =
  /(token|secret|password|authorization|cookie|api[_-]?key|oauth|credential)/i;

/**
 * Asserts that a P4 collaboration audit payload is strictly safe, conformant,
 * non-sensitive, and within byte-size limits.
 */
export function assertSafeCollaborationAuditPayload<T extends CollaborationAuditEventType>(
  eventType: T,
  payload: unknown,
): asserts payload is CollaborationAuditPayloadMap[T] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Collaboration audit payload for event '${eventType}' must be a non-null object`,
      false,
    );
  }

  const obj = payload as Record<string, unknown>;
  if (obj.schemaVersion !== P4_AUDIT_SCHEMA_VERSION) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Collaboration audit payload for event '${eventType}' must include schemaVersion ${P4_AUDIT_SCHEMA_VERSION}`,
      false,
    );
  }

  if (!COLLABORATION_AUDIT_EVENT_TYPES.includes(eventType)) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Unknown collaboration audit event type '${eventType}'`,
      false,
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Collaboration audit payload for event '${eventType}' is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  if (Buffer.byteLength(serialized, "utf8") > 16384) {
    throw new BridgeError(
      "collaboration_audit_failed",
      `Collaboration audit payload for event '${eventType}' exceeds maximum 16 KiB limit`,
      false,
    );
  }

  function validateNode(node: unknown, path: string): void {
    if (node === null || node === undefined) return;
    const t = typeof node;
    if (t === "function" || t === "symbol" || t === "bigint") {
      throw new BridgeError(
        "collaboration_audit_failed",
        `Disallowed ${t} found in audit payload at path '${path}'`,
        false,
      );
    }
    if (t === "string" && (node as string).length > 4096) {
      throw new BridgeError(
        "collaboration_audit_failed",
        `Audit string value exceeds maximum length at path '${path}'`,
        false,
      );
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => validateNode(item, `${path}[${idx}]`));
    } else if (t === "object") {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_KEY_PATTERN.test(key)) {
          throw new BridgeError(
            "collaboration_audit_failed",
            `Forbidden audit key '${key}' at path '${path}.${key}' in event '${eventType}'`,
            false,
          );
        }
        if (FORBIDDEN_CREDENTIAL_SUBSTRING.test(key)) {
          throw new BridgeError(
            "collaboration_audit_failed",
            `Sensitive credential key '${key}' at path '${path}.${key}' in event '${eventType}'`,
            false,
          );
        }
        validateNode(val, `${path}.${key}`);
      }
    }
  }

  validateNode(payload, "payload");
}

/**
 * Emits a strongly-typed, validated collaboration audit event to AuditStore.
 * Enforces data minimization and bounds before writing.
 *
 * NOTE: If audit writing fails, this throws BridgeError("collaboration_audit_failed")
 * without mutating or reverting canonical persistence.
 */
export function emitCollaborationAuditEvent<T extends CollaborationAuditEventType>(
  auditStore: AuditStore,
  params: {
    eventType: T;
    runId: string;
    sessionId: string;
    turnId?: string;
    createdAt?: string;
    payload: CollaborationAuditPayloadMap[T];
  },
): void {
  assertSafeCollaborationAuditPayload(params.eventType, params.payload);
  try {
    auditStore.log({
      eventType: params.eventType,
      runId: params.runId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      createdAt: params.createdAt || new Date().toISOString(),
      payload: params.payload,
    });
  } catch (err) {
    if (err instanceof BridgeError) {
      throw err;
    }
    throw new BridgeError(
      "collaboration_audit_failed",
      `Failed to write collaboration audit event '${params.eventType}': ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

export interface CollaborationObservabilitySnapshot {
  readonly runId: string;
  readonly status: string;
  readonly participantCount: number;
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly failedAttempts: number;
  readonly cancelledAttempts: number;
  readonly totalDurationMs?: number;
  readonly perParticipant: ReadonlyArray<{
    readonly participantId: string;
    readonly roleId: string;
    readonly turnsExecuted: number;
    readonly consecutiveFailures: number;
    readonly status: string;
  }>;
}

/**
 * Lightweight, pure snapshot generator derived strictly from canonical persistence.
 */
export function buildCollaborationObservabilitySnapshot(
  run: RoleBasedCollaborationRun,
  turns: readonly CollaborationTurnRecord[],
): CollaborationObservabilitySnapshot {
  let completedAttempts = 0;
  let failedAttempts = 0;
  let cancelledAttempts = 0;
  let totalDurationMs = 0;

  for (const turn of turns) {
    if (turn.status === "completed") completedAttempts++;
    else if (turn.status === "failed") failedAttempts++;
    else if (turn.status === "cancelled") cancelledAttempts++;
    if (typeof turn.durationMs === "number") {
      totalDurationMs += turn.durationMs;
    }
  }

  const perParticipant = run.participantIds.map((id) => {
    const part = run.participantsById[id];
    return {
      participantId: id,
      roleId: part?.roleId ?? "unknown",
      turnsExecuted: part?.turnsExecuted ?? 0,
      consecutiveFailures: part?.consecutiveFailures ?? 0,
      status: part?.status ?? "unknown",
    };
  });

  return {
    runId: run.id,
    status: run.status,
    participantCount: run.participantIds.length,
    totalAttempts: turns.length,
    completedAttempts,
    failedAttempts,
    cancelledAttempts,
    totalDurationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
    perParticipant,
  };
}
