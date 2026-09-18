import type {
  CollaborationDagDefinition,
  CollaborationDagExecutionPlan,
  CollaborationDagFailurePolicy,
  CollaborationDagNodeRecord,
  CollaborationDagRunMetadata,
  PersistedCollaborationDagInput,
} from "./collaboration-dag";
import type {
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedCollaborationRun,
  RoleBasedRunPatch,
} from "./collaboration-domain";
import type { ParticipantAssignmentPlan } from "./participant-assignment";
import type { CollaborationMessageRecord } from "./collaboration-transcript";
import type { PersistedParticipant } from "./collaboration-persistence";

export interface CollaborationDagPersistence {
  createInitialDagRun(params: {
    readonly run: RoleBasedCollaborationRun;
    readonly plans: readonly ParticipantAssignmentPlan[];
    readonly graph: CollaborationDagDefinition;
    readonly plan: CollaborationDagExecutionPlan;
    readonly failurePolicy: CollaborationDagFailurePolicy;
  }): void;

  markNodeReady(runId: string, nodeId: string): void;

  markNodeTerminal(params: {
    readonly runId: string;
    readonly nodeId: string;
    readonly status: "failed" | "skipped" | "cancelled";
    readonly completedAt: string;
    readonly error?: CollaborationDagNodeRecord["error"];
  }): void;

  markNodeRunningTransaction(params: {
    readonly runId: string;
    readonly nodeId: string;
    readonly participant: ParticipantRecord;
    readonly attempt: number;
    readonly startedAt: string;
  }): void;

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
  }): void;

  finalizeRun(runId: string, updates: RoleBasedRunPatch): void;

  getRun(runId: string): RoleBasedCollaborationRun | null;
  getMetadata(runId: string): CollaborationDagRunMetadata | null;
  getNodes(runId: string): CollaborationDagNodeRecord[];
  getInputs(runId: string, nodeId?: string): PersistedCollaborationDagInput[];
  getTranscript(runId: string): CollaborationMessageRecord[];
  getParticipants(runId: string): PersistedParticipant[];
  getMessagesByNode(runId: string): Readonly<Record<string, CollaborationMessageRecord>>;
}
