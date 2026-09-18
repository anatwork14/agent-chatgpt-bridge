import type {
  RoleId,
  RoleDefinition,
  ParticipantConfig,
  ParticipantRecord,
  ParticipantStatus,
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
  RoleBasedRunPatch,
  RoleBasedCollaborationRunStatus,
} from "./collaboration-domain";
import {
  applyRoleBasedRunPatch,
  isRoleBasedRunTerminalStatus,
  assertRoleBasedRunPatchAllowed,
} from "./collaboration-domain";
import type { ParticipantAssignmentPlan } from "./participant-assignment";
import type { CollaborationMessageRecord } from "./collaboration-transcript";
import { assertCollaborationMessageIntegrity } from "./collaboration-transcript";
import { BridgeError } from "./errors";


/**
 * Full persisted participant representation reconstructed from storage,
 * including historical role definition and sanitized configuration snapshots.
 */
export interface PersistedParticipant {
  readonly id: string;
  readonly runId: string;
  readonly roleId: RoleId;
  readonly adapterId: string;
  readonly roleSnapshot: RoleDefinition;
  readonly configSnapshot: ParticipantConfig;
  readonly status: ParticipantStatus;
  readonly turnsExecuted: number;
  readonly consecutiveFailures: number;
  readonly sequenceIndex: number;
  readonly createdAt: string;
  readonly lastActiveAt?: string;
}

/**
 * Denylist regex targeting credential-like keys across nested participant config structures.
 */
const SENSITIVE_KEY_REGEX =
  /^(token|apikey|authorization|cookie|password|secret|oauthtoken|accesstoken|refreshtoken)$/i;

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      continue;
    }
    result[k] = sanitizeValue(v);
  }
  return result;
}

/**
 * Defensively sanitizes participant configuration snapshots before persistence,
 * ensuring no credentials, auth tokens, or cookies enter durable storage.
 */
export function sanitizeParticipantConfig(config: ParticipantConfig): ParticipantConfig {
  return sanitizeValue(config) as ParticipantConfig;
}

/**
 * Core persistence abstraction for Phase P4 role-based collaboration runs.
 * Defines the contract implemented by SQLite storage without coupling core orchestration
 * to concrete database drivers.
 */
export interface RoleBasedRunPersistence {
  createInitialRun(
    run: RoleBasedCollaborationRun,
    plans: readonly ParticipantAssignmentPlan[],
  ): void;

  recordTurnTransaction(params: {
    readonly turn: CollaborationTurnRecord;
    readonly message?: CollaborationMessageRecord;
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void;

  updateParticipantAndRunTransaction(params: {
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void;

  finalizeRun(id: string, updates: RoleBasedRunPatch): void;

  getRun(id: string): RoleBasedCollaborationRun | null;

  getTurns(runId: string): CollaborationTurnRecord[];

  listRunsBySession(sessionId: string): RoleBasedCollaborationRun[];

  getTranscript(runId: string): CollaborationMessageRecord[];

  /**
   * Returns all persisted participants for a run, sorted by sequenceIndex ASC.
   * Used exclusively by the P4.6 recovery and resume paths.
   */
  getParticipants(runId: string): PersistedParticipant[];

  /**
   * Returns all runs whose status is one of the provided statuses.
   * Used exclusively by the P4.6 recovery path to find orphaned running runs.
   */
  listRunsByStatuses(statuses: readonly RoleBasedCollaborationRunStatus[]): RoleBasedCollaborationRun[];
}


/**
 * Deterministic in-memory implementation of RoleBasedRunPersistence.
 * Useful for isolated unit tests, offline fixtures, and fallback.
 */
export class InMemoryRoleBasedRunPersistence implements RoleBasedRunPersistence {
  private readonly runs = new Map<string, RoleBasedCollaborationRun>();
  private readonly participantsByRun = new Map<string, Map<string, PersistedParticipant>>();
  private readonly turnsByRun = new Map<string, CollaborationTurnRecord[]>();
  private readonly messagesByRun = new Map<string, CollaborationMessageRecord[]>();

  createInitialRun(
    run: RoleBasedCollaborationRun,
    plans: readonly ParticipantAssignmentPlan[],
  ): void {
    if (this.runs.has(run.id)) {
      throw new BridgeError("conflict", `Role-based run '${run.id}' already exists`, false);
    }
    this.runs.set(run.id, { ...run });

    const partMap = new Map<string, PersistedParticipant>();
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const record = run.participantsById[plan.participantId];
      if (!record) {
        throw new BridgeError(
          "invalid_request",
          `Missing participant record for '${plan.participantId}'`,
          false,
        );
      }
      partMap.set(plan.participantId, {
        id: plan.participantId,
        runId: run.id,
        roleId: plan.roleId,
        adapterId: plan.adapterId,
        roleSnapshot: plan.role,
        configSnapshot: sanitizeParticipantConfig(plan.config),
        status: record.status,
        turnsExecuted: record.turnsExecuted,
        consecutiveFailures: record.consecutiveFailures,
        sequenceIndex: i,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
      });
    }
    this.participantsByRun.set(run.id, partMap);
    this.turnsByRun.set(run.id, []);
    this.messagesByRun.set(run.id, []);
  }

  recordTurnTransaction(params: {
    readonly turn: CollaborationTurnRecord;
    readonly message?: CollaborationMessageRecord;
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void {
    const run = this.runs.get(params.runUpdates.id);
    if (!run) {
      throw new BridgeError("not_found", `Role-based run '${params.runUpdates.id}' not found`, false);
    }

    assertRoleBasedRunPatchAllowed(run, params.runUpdates);

    const turns = this.turnsByRun.get(run.id) ?? [];
    if (turns.some((t) => t.turnIndex === params.turn.turnIndex)) {
      throw new BridgeError("conflict", `Turn index ${params.turn.turnIndex} already exists`, false);
    }

    const messages = this.messagesByRun.get(run.id) ?? [];
    if (params.message) {
      if (messages.some((m) => m.sequenceIndex === params.message!.sequenceIndex)) {
        throw new BridgeError(
          "conflict",
          `Message sequence index ${params.message.sequenceIndex} already exists`,
          false,
        );
      }
      assertCollaborationMessageIntegrity(params.message);
    }

    const partMap = this.participantsByRun.get(run.id);
    if (!partMap) {
      throw new BridgeError("not_found", `Participants for run '${run.id}' not found`, false);
    }
    const existingPart = partMap.get(params.participant.id);
    if (!existingPart) {
      throw new BridgeError("not_found", `Participant '${params.participant.id}' not found`, false);
    }

    // Atomic commit
    turns.push({ ...params.turn });
    this.turnsByRun.set(run.id, turns);

    if (params.message) {
      messages.push({ ...params.message });
      this.messagesByRun.set(run.id, messages);
    }

    partMap.set(params.participant.id, {
      ...existingPart,
      status: params.participant.status,
      turnsExecuted: params.participant.turnsExecuted,
      consecutiveFailures: params.participant.consecutiveFailures,
      lastActiveAt: params.participant.lastActiveAt,
    });

    const updatedParticipantsById: Record<string, ParticipantRecord> = {
      ...run.participantsById,
      [params.participant.id]: { ...params.participant },
    };

    const updatedTurnHistory = [...run.turnHistory, params.turn.id];
    const patchedRun = applyRoleBasedRunPatch(run, params.runUpdates);

    this.runs.set(run.id, {
      ...patchedRun,
      participantsById: updatedParticipantsById,
      turnHistory: updatedTurnHistory,
    });
  }

  updateParticipantAndRunTransaction(params: {
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void {
    const run = this.runs.get(params.runUpdates.id);
    if (!run) {
      throw new BridgeError("not_found", `Role-based run '${params.runUpdates.id}' not found`, false);
    }

    assertRoleBasedRunPatchAllowed(run, params.runUpdates);

    const partMap = this.participantsByRun.get(run.id);
    if (!partMap) {
      throw new BridgeError("not_found", `Participants for run '${run.id}' not found`, false);
    }
    const existingPart = partMap.get(params.participant.id);
    if (!existingPart) {
      throw new BridgeError("not_found", `Participant '${params.participant.id}' not found`, false);
    }

    partMap.set(params.participant.id, {
      ...existingPart,
      status: params.participant.status,
      turnsExecuted: params.participant.turnsExecuted,
      consecutiveFailures: params.participant.consecutiveFailures,
      lastActiveAt: params.participant.lastActiveAt,
    });

    const updatedParticipantsById: Record<string, ParticipantRecord> = {
      ...run.participantsById,
      [params.participant.id]: { ...params.participant },
    };

    const patchedRun = applyRoleBasedRunPatch(run, params.runUpdates);

    this.runs.set(run.id, {
      ...patchedRun,
      participantsById: updatedParticipantsById,
    });
  }

  finalizeRun(id: string, updates: RoleBasedRunPatch): void {
    const run = this.runs.get(id);
    if (!run) {
      throw new BridgeError("not_found", `Role-based run '${id}' not found`, false);
    }

    assertRoleBasedRunPatchAllowed(run, updates);

    const patchedRun = applyRoleBasedRunPatch(run, updates);
    this.runs.set(id, patchedRun);
  }

  getRun(id: string): RoleBasedCollaborationRun | null {
    const run = this.runs.get(id);
    if (!run) return null;
    return { ...run };
  }

  getTurns(runId: string): CollaborationTurnRecord[] {
    const turns = this.turnsByRun.get(runId) ?? [];
    return turns.map((t) => ({ ...t }));
  }

  listRunsBySession(sessionId: string): RoleBasedCollaborationRun[] {
    return Array.from(this.runs.values())
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getTranscript(runId: string): CollaborationMessageRecord[] {
    const messages = this.messagesByRun.get(runId) ?? [];
    for (const msg of messages) {
      assertCollaborationMessageIntegrity(msg);
    }
    return messages.map((m) => ({ ...m }));
  }

  getParticipants(runId: string): PersistedParticipant[] {
    const partMap = this.participantsByRun.get(runId);
    if (!partMap) return [];
    return Array.from(partMap.values()).sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  }

  listRunsByStatuses(statuses: readonly RoleBasedCollaborationRunStatus[]): RoleBasedCollaborationRun[] {
    const statusSet = new Set<string>(statuses);
    return Array.from(this.runs.values())
      .filter((r) => statusSet.has(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

