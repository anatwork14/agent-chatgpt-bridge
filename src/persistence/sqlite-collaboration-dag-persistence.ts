import { getDatabase } from "./database";
import { RoleBasedRunStore } from "./role-based-run-store";
import { CollaborationParticipantStore } from "./collaboration-participant-store";
import { CollaborationTurnStore } from "./collaboration-turn-store";
import { CollaborationMessageStore } from "./collaboration-message-store";
import { CollaborationDagStore } from "./collaboration-dag-store";
import type { CollaborationDagPersistence } from "../core/collaboration-dag-persistence";
import type {
  CollaborationDagNodeRecord,
  CollaborationDagRunMetadata,
  PersistedCollaborationDagInput,
} from "../core/collaboration-dag";
import type {
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedCollaborationRun,
  RoleBasedRunPatch,
} from "../core/collaboration-domain";
import type { CollaborationMessageRecord } from "../core/collaboration-transcript";
import { assertCollaborationMessageIntegrity } from "../core/collaboration-transcript";
import type { PersistedParticipant } from "../core/collaboration-persistence";
import { BridgeError } from "../core/errors";

export class SqliteCollaborationDagPersistence implements CollaborationDagPersistence {
  constructor(
    private readonly runStore = new RoleBasedRunStore(),
    private readonly participantStore = new CollaborationParticipantStore(),
    private readonly turnStore = new CollaborationTurnStore(),
    private readonly messageStore = new CollaborationMessageStore(),
    private readonly dagStore = new CollaborationDagStore(),
  ) {}

  createInitialDagRun(params: Parameters<CollaborationDagPersistence["createInitialDagRun"]>[0]): void {
    const db = getDatabase();
    db.transaction(() => {
      this.runStore.create(params.run);
      this.participantStore.createMany(params.run.id, params.plans, {
        participantIds: params.run.participantIds,
        participantsById: params.run.participantsById,
      });
      const roleIdByParticipant: Record<string, any> = {};
      for (const participant of params.plans) {
        roleIdByParticipant[participant.participantId] = participant.roleId;
      }
      this.dagStore.create({
        runId: params.run.id,
        graph: params.graph,
        plan: params.plan,
        failurePolicy: params.failurePolicy,
        maxParallelTurns: params.run.budget.maxParallelTurns,
        roleIdByParticipant,
      });
    })();
  }

  markNodeReady(runId: string, nodeId: string): void {
    const existing = this.dagStore.getNode(runId, nodeId);
    if (!existing) {
      throw new BridgeError("not_found", `DAG node '${nodeId}' not found in run '${runId}'`, false);
    }
    if (existing.status === "ready") return;
    this.dagStore.updateNode(runId, nodeId, { status: "ready" });
  }

  reconcileInterruptedNode(params: {
    readonly runId: string;
    readonly nodeId: string;
    readonly participant: ParticipantRecord;
    readonly recoveredAt: string;
  }): void {
    const existing = this.dagStore.getNode(params.runId, params.nodeId);
    if (!existing) {
      throw new BridgeError(
        "not_found",
        `DAG node '${params.nodeId}' not found in run '${params.runId}'`,
        false,
      );
    }
    if (existing.status !== "running") {
      throw new BridgeError(
        "invalid_state_transition",
        `Cannot reconcile DAG node '${params.nodeId}' from status '${existing.status}'`,
        false,
      );
    }

    const db = getDatabase();
    db.transaction(() => {
      this.participantStore.update(params.participant.id, params.participant);
      this.dagStore.updateNode(params.runId, params.nodeId, {
        status: "ready",
        startedAt: null,
        completedAt: null,
        error: {
          code: "daemon_restarted",
          message: "In-flight DAG node was interrupted by daemon restart",
          retryable: true,
        },
      });
    })();
  }

  markNodeTerminal(params: {
    readonly runId: string;
    readonly nodeId: string;
    readonly status: "failed" | "skipped" | "cancelled";
    readonly completedAt: string;
    readonly error?: CollaborationDagNodeRecord["error"];
  }): void {
    const existing = this.dagStore.getNode(params.runId, params.nodeId);
    if (!existing) {
      throw new BridgeError("not_found", `DAG node '${params.nodeId}' not found in run '${params.runId}'`, false);
    }
    if (existing.status === params.status) return;
    this.dagStore.updateNode(params.runId, params.nodeId, {
      status: params.status,
      completedAt: params.completedAt,
      error: params.error,
    });
  }

  markNodeRunningTransaction(params: {
    readonly runId: string;
    readonly nodeId: string;
    readonly participant: ParticipantRecord;
    readonly attempt: number;
    readonly startedAt: string;
  }): void {
    const db = getDatabase();
    db.transaction(() => {
      this.participantStore.update(params.participant.id, params.participant);
      this.dagStore.updateNode(params.runId, params.nodeId, {
        status: "running",
        attempt: params.attempt,
        startedAt: params.startedAt,
        completedAt: null,
        error: null,
      });
    })();
  }

  recordNodeAttemptTransaction(params: {
    readonly nodeId: string;
    readonly turn: CollaborationTurnRecord;
    readonly message?: CollaborationMessageRecord;
    readonly provenance: PersistedCollaborationDagInput;
    readonly participant: ParticipantRecord;
    readonly nodeOutcome:
      | { readonly status: "completed"; readonly completedAt: string; readonly outputMessageId: string }
      | {
          readonly status: "ready" | "failed" | "cancelled";
          readonly completedAt?: string;
          readonly error?: CollaborationDagNodeRecord["error"];
        };
    readonly runUpdates?: RoleBasedRunPatch;
  }): void {
    if (params.provenance.turnId !== params.turn.id) {
      throw new BridgeError(
        "invalid_collaboration_dag",
        "DAG provenance turnId must match the persisted collaboration turn",
        false,
      );
    }
    if (params.message) {
      assertCollaborationMessageIntegrity(params.message);
      if (params.message.turnId !== params.turn.id || params.message.runId !== params.turn.runId) {
        throw new BridgeError(
          "invalid_collaboration_dag",
          "DAG output message must belong to the same run and turn",
          false,
        );
      }
    }

    const db = getDatabase();
    db.transaction(() => {
      this.turnStore.create(params.turn);
      if (params.message) {
        this.messageStore.create(params.message);
      }
      this.dagStore.insertInput(params.provenance);
      this.participantStore.update(params.participant.id, params.participant);

      if (params.nodeOutcome.status === "completed") {
        if (!params.message || params.nodeOutcome.outputMessageId !== params.message.id) {
          throw new BridgeError(
            "invalid_collaboration_dag",
            "Completed DAG node must reference the canonical output message committed in the same transaction",
            false,
          );
        }
        this.dagStore.updateNode(params.turn.runId, params.nodeId, {
          status: "completed",
          completedAt: params.nodeOutcome.completedAt,
          outputMessageId: params.nodeOutcome.outputMessageId,
          error: null,
        });
      } else {
        this.dagStore.updateNode(params.turn.runId, params.nodeId, {
          status: params.nodeOutcome.status,
          completedAt: params.nodeOutcome.completedAt,
          error: params.nodeOutcome.error,
        });
      }

      if (params.runUpdates) {
        this.runStore.update(params.turn.runId, params.runUpdates);
      }
    })();
  }

  finalizeRun(runId: string, updates: RoleBasedRunPatch): void {
    this.runStore.update(runId, updates);
  }

  listRunsByStatuses(statuses: readonly string[]): RoleBasedCollaborationRun[] {
    return this.runStore
      .listByStatuses(statuses)
      .filter(run => this.dagStore.getMetadata(run.id) !== null);
  }

  getRun(runId: string): RoleBasedCollaborationRun | null {
    return this.runStore.get(runId);
  }

  getMetadata(runId: string): CollaborationDagRunMetadata | null {
    return this.dagStore.getMetadata(runId);
  }

  getNodes(runId: string): CollaborationDagNodeRecord[] {
    return this.dagStore.listNodes(runId);
  }

  getInputs(runId: string, nodeId?: string): PersistedCollaborationDagInput[] {
    return this.dagStore.listInputs(runId, nodeId);
  }

  getTranscript(runId: string): CollaborationMessageRecord[] {
    return this.messageStore.listByRun(runId);
  }

  getParticipants(runId: string): PersistedParticipant[] {
    return this.participantStore.listByRun(runId);
  }

  getMessagesByNode(runId: string): Readonly<Record<string, CollaborationMessageRecord>> {
    const result: Record<string, CollaborationMessageRecord> = {};
    for (const node of this.dagStore.listNodes(runId)) {
      if (!node.outputMessageId) continue;
      const message = this.messageStore.get(node.outputMessageId);
      if (!message) {
        throw new BridgeError(
          "persistence_corruption",
          `DAG node '${node.id}' references missing output message '${node.outputMessageId}'`,
          false,
        );
      }
      assertCollaborationMessageIntegrity(message);
      result[node.id] = message;
    }
    return result;
  }
}
