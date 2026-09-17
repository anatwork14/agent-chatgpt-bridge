import { getDatabase } from "./database";
import type {
  RoleBasedRunPersistence,
  PersistedParticipant,
} from "../core/collaboration-persistence";
import type {
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedRunPatch,
  RoleBasedCollaborationRunStatus,
} from "../core/collaboration-domain";
import type { ParticipantAssignmentPlan } from "../core/participant-assignment";
import type { CollaborationMessageRecord } from "../core/collaboration-transcript";
import { RoleBasedRunStore } from "./role-based-run-store";
import { CollaborationParticipantStore } from "./collaboration-participant-store";
import { CollaborationTurnStore } from "./collaboration-turn-store";
import { CollaborationMessageStore } from "./collaboration-message-store";


/**
 * Concrete SQLite implementation of RoleBasedRunPersistence.
 * Executes multi-table writes inside atomic SQLite transactions,
 * providing the durable source of truth for P4 multi-participant collaboration.
 */
export class SqliteCollaborationPersistence implements RoleBasedRunPersistence {
  constructor(
    private readonly runStore = new RoleBasedRunStore(),
    private readonly participantStore = new CollaborationParticipantStore(),
    private readonly turnStore = new CollaborationTurnStore(),
    private readonly messageStore = new CollaborationMessageStore(),
  ) {}

  createInitialRun(
    run: RoleBasedCollaborationRun,
    plans: readonly ParticipantAssignmentPlan[],
  ): void {
    const db = getDatabase();
    db.transaction(() => {
      this.runStore.create(run);
      this.participantStore.createMany(run.id, plans, {
        participantIds: run.participantIds,
        participantsById: run.participantsById,
      });
    })();
  }

  recordTurnTransaction(params: {
    readonly turn: CollaborationTurnRecord;
    readonly message?: CollaborationMessageRecord;
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void {
    const db = getDatabase();
    db.transaction(() => {
      // 1. Insert turn record
      this.turnStore.create(params.turn);

      // 2. Insert canonical message if produced
      if (params.message) {
        this.messageStore.create(params.message);
      }

      // 3. Update participant state
      this.participantStore.update(params.participant.id, params.participant);

      // 4. Update run state
      this.runStore.update(params.runUpdates.id, params.runUpdates);
    })();
  }

  updateParticipantAndRunTransaction(params: {
    readonly participant: ParticipantRecord;
    readonly runUpdates: RoleBasedRunPatch & { readonly id: string };
  }): void {
    const db = getDatabase();
    db.transaction(() => {
      this.participantStore.update(params.participant.id, params.participant);
      this.runStore.update(params.runUpdates.id, params.runUpdates);
    })();
  }

  finalizeRun(id: string, updates: RoleBasedRunPatch): void {
    this.runStore.update(id, updates);
  }

  getRun(id: string): RoleBasedCollaborationRun | null {
    return this.runStore.get(id);
  }

  getTurns(runId: string): CollaborationTurnRecord[] {
    return this.turnStore.listByRun(runId);
  }

  listRunsBySession(sessionId: string): RoleBasedCollaborationRun[] {
    return this.runStore.listBySession(sessionId);
  }

  getTranscript(runId: string): CollaborationMessageRecord[] {
    return this.messageStore.listByRun(runId);
  }

  getParticipants(runId: string): PersistedParticipant[] {
    return this.participantStore.listByRun(runId);
  }

  listRunsByStatuses(statuses: readonly RoleBasedCollaborationRunStatus[]): RoleBasedCollaborationRun[] {
    return this.runStore.listByStatuses(statuses);
  }
}


