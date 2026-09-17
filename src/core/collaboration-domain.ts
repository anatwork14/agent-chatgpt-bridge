import type {
  BridgeOutputContract,
  ExternalAgentAdapterConfig,
  AgentDecision,
} from "./domain";
import { BridgeError } from "./errors";

/**
 * Built-in logical collaboration roles.
 * Logical roles represent specialized engineering responsibilities and are
 * strictly independent of underlying model providers, vendors, or transport protocols.
 */
export const BUILTIN_ROLE_IDS = [
  "primary",
  "architect",
  "researcher",
  "implementer",
  "critic",
  "reviewer",
  "verifier",
] as const;

export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

export type RoleId = BuiltinRoleId | (string & {});

/**
 * Pure, serializable specification of a logical collaboration role.
 * Contains no runtime handles, closures, or provider credentials.
 */
export interface RoleDefinition {
  readonly id: RoleId;
  readonly name: string;
  readonly description: string;
  readonly systemInstructions: string;
  readonly expectedInputSummary?: string;
  readonly outputContract?: BridgeOutputContract;
}

/**
 * Serializable configuration for instantiating a participant's adapter.
 */
export interface ParticipantConfig {
  readonly adapterType: string;
  readonly command?: string[];
  readonly config?: ExternalAgentAdapterConfig;
  readonly cwd?: string;
}

/**
 * Explicit binding of a role to a participant configuration.
 */
export interface RoleAssignment {
  readonly roleId: RoleId;
  readonly participantConfig: ParticipantConfig;
}

export type ParticipantStatus =
  | "pending"
  | "ready"
  | "active"
  | "idle"
  | "failed"
  | "cancelled";

/**
 * Persisted state of a participant within a collaboration run.
 * Contains only serializable state. Process handles, AbortControllers, and
 * ExternalAgentAdapter instances reside exclusively in memory during turn execution.
 */
export interface ParticipantRecord {
  readonly id: string;
  readonly roleId: RoleId;
  readonly adapterId: string;
  readonly status: ParticipantStatus;
  readonly turnsExecuted: number;
  readonly consecutiveFailures: number;
  readonly createdAt: string;
  readonly lastActiveAt?: string;
}

export interface RoleBasedRunBudget {
  /** Maximum total turns across ALL participants in the run */
  readonly maxTurns: number;
  /** Maximum participants allowed to be instantiated in this run */
  readonly maxParticipants: number;
  /** Strictly 1 for P4 (enforces sequential turns; parallel execution belongs to P5) */
  readonly maxParallelTurns: 1;
  /** Maximum consecutive retries allowed per participant before failure escalation */
  readonly maxRetriesPerParticipant: number;
  /** Hard total wall-clock limit in milliseconds */
  readonly maxWallClockMs: number;
  /** Extensible token/cost thresholds (optional) */
  readonly tokenBudget?: {
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly maxTotalTokens?: number;
  };
}

/**
 * Hard safety caps to prevent runaway execution, unbounded billing, or resource starvation.
 */
export const P4_LIMITS = {
  maxTurns: 100,
  maxParticipants: 10,
  maxRetriesPerParticipant: 5,
  maxWallClockMs: 4 * 60 * 60 * 1000, // 4 hours
} as const;

export const P4_DEFAULT_BUDGET: RoleBasedRunBudget = {
  maxTurns: 30,
  maxParticipants: 5,
  maxParallelTurns: 1,
  maxRetriesPerParticipant: 2,
  maxWallClockMs: 60 * 60 * 1000, // 1 hour
};

export type RunLoopMode = "once" | "repeat_until_done";

/**
 * Orchestration policy governing turn sequencing and completion rules.
 */
export interface RunPolicy {
  /** Sequential role execution order */
  readonly roleSequence: RoleId[];
  /** Execution cadence: execute sequence once or loop until done */
  readonly loopMode: RunLoopMode;
  /** Designated roles authorized to emit authoritative 'done' termination */
  readonly terminalRoles: RoleId[];
}

export type CollaborationTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Serializable record of a single participant turn in the collaboration run.
 */
export interface CollaborationTurnRecord {
  readonly id: string;
  readonly runId: string;
  readonly round: number;
  readonly turnIndex: number;
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly status: CollaborationTurnStatus;
  readonly inputSummary: string;
  readonly decision?: AgentDecision;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
}

export type RoleBasedCollaborationRunStatus =
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "timed_out";

export const ROLE_BASED_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
  "timed_out",
] as const;

export type RoleBasedRunTerminalStatus = (typeof ROLE_BASED_TERMINAL_STATUSES)[number];

export function isRoleBasedRunTerminalStatus(
  status: RoleBasedCollaborationRunStatus,
): status is RoleBasedRunTerminalStatus {
  return (ROLE_BASED_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Explicit patch representation for updating a RoleBasedCollaborationRun.
 * - omitted (undefined): unchanged
 * - null: clear to undefined (SQL NULL)
 * - concrete value: set
 */
export interface RoleBasedRunPatch {
  readonly status?: RoleBasedCollaborationRunStatus;
  readonly round?: number;
  readonly activeParticipantId?: string | null;
  readonly finalSummary?: string | null;
  readonly completedAt?: string | null;
}

export function applyRoleBasedRunPatch(
  run: RoleBasedCollaborationRun,
  patch: RoleBasedRunPatch,
): RoleBasedCollaborationRun {
  return {
    ...run,
    status: patch.status !== undefined ? patch.status : run.status,
    round: patch.round !== undefined ? patch.round : run.round,
    activeParticipantId:
      patch.activeParticipantId === null
        ? undefined
        : patch.activeParticipantId !== undefined
          ? patch.activeParticipantId
          : run.activeParticipantId,
    finalSummary:
      patch.finalSummary === null
        ? undefined
        : patch.finalSummary !== undefined
          ? patch.finalSummary
          : run.finalSummary,
    completedAt:
      patch.completedAt === null
        ? undefined
        : patch.completedAt !== undefined
          ? patch.completedAt
          : run.completedAt,
  };
}

/**
 * Asserts that a RoleBasedRunPatch is legally applicable to the given run.
 * For terminal runs (completed, failed, cancelled, budget_exhausted, timed_out),
 * all lifecycle fields (status, round, activeParticipantId, finalSummary, completedAt)
 * are immutable. Only idempotent writes containing the exact existing values are allowed.
 */
export function assertRoleBasedRunPatchAllowed(
  existingRun: RoleBasedCollaborationRun,
  patch: RoleBasedRunPatch,
): void {
  if (isRoleBasedRunTerminalStatus(existingRun.status)) {
    const patched = applyRoleBasedRunPatch(existingRun, patch);
    if (
      patched.status !== existingRun.status ||
      patched.round !== existingRun.round ||
      patched.activeParticipantId !== existingRun.activeParticipantId ||
      patched.finalSummary !== existingRun.finalSummary ||
      patched.completedAt !== existingRun.completedAt
    ) {
      throw new BridgeError(
        "invalid_state_transition",
        `Cannot modify terminal role-based run '${existingRun.id}' (status: '${existingRun.status}')`,
        false,
      );
    }
  }
}

/**
 * Maximum permitted size in bytes for an external cancellation reason (8 KiB).
 */
export const MAX_CANCELLATION_REASON_BYTES = 8 * 1024;

/**
 * Normalizes and validates a cancellation reason string:
 * - CRLF is replaced with LF
 * - Unicode NFC normalization
 * - Strict length bounding (<= 8 KiB)
 */
export function normalizeCancellationReason(rawReason?: string): string {
  if (!rawReason) {
    return "Collaboration run was cancelled";
  }
  const normalized = rawReason.replace(/\r\n/g, "\n").normalize("NFC");
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > MAX_CANCELLATION_REASON_BYTES) {
    throw new BridgeError(
      "invalid_request",
      `Cancellation reason exceeds maximum size bound of ${MAX_CANCELLATION_REASON_BYTES} bytes (${byteLength} bytes provided)`,
      false,
    );
  }
  return normalized;
}

/**
 * Structured internal runtime abort reasons.
 */
export type RoleRunAbortReason =
  | {
      readonly kind: "run_cancelled";
      readonly reason: string;
    }
  | {
      readonly kind: "participant_cancelled";
      readonly participantId: string;
      readonly reason: string;
    };

/**
 * Typed abort error carrying a structured RoleRunAbortReason.
 */
export class RoleRunAbortError extends Error {
  public readonly abortReason: RoleRunAbortReason;

  constructor(abortReason: RoleRunAbortReason) {
    super(
      abortReason.kind === "run_cancelled"
        ? abortReason.reason
        : `Required participant '${abortReason.participantId}' was cancelled: ${abortReason.reason}`,
    );
    this.name = "AbortError";
    this.abortReason = abortReason;
  }
}

export function createRoleRunAbortError(abortReason: RoleRunAbortReason): RoleRunAbortError {
  return new RoleRunAbortError(abortReason);
}

export function readRoleRunAbortReason(reason: unknown): RoleRunAbortReason | null {
  if (reason instanceof RoleRunAbortError) {
    return reason.abortReason;
  }
  if (
    reason &&
    typeof reason === "object" &&
    "abortReason" in reason &&
    typeof (reason as any).abortReason === "object"
  ) {
    return (reason as any).abortReason;
  }
  if (
    reason &&
    typeof reason === "object" &&
    "kind" in reason &&
    ((reason as any).kind === "run_cancelled" || (reason as any).kind === "participant_cancelled")
  ) {
    return reason as RoleRunAbortReason;
  }
  return null;
}

/**
 * Additive P4 multi-participant collaboration run record.
 * Uses deterministic participant ordering through participantIds, with
 * O(1) indexed lookup through participantsById.
 */
export interface RoleBasedCollaborationRun {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: RoleBasedCollaborationRunStatus;
  readonly round: number;
  readonly budget: RoleBasedRunBudget;
  readonly policy: RunPolicy;
  /** Explicit, deterministic participant ordering */
  readonly participantIds: string[];
  /** O(1) indexed lookup of participant records by participant ID */
  readonly participantsById: Record<string, ParticipantRecord>;
  readonly activeParticipantId?: string;
  /** Chronological history of collaboration turn IDs */
  readonly turnHistory: string[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly finalSummary?: string;
}

/**
 * Configuration supplied to initiate a role-based collaboration run.
 */
export interface CollaborationConfig {
  readonly objective: string;
  readonly policy: RunPolicy;
  readonly roles: Partial<Record<RoleId, ParticipantConfig>> | RoleAssignment[];
  readonly budget?: Partial<RoleBasedRunBudget>;
}
