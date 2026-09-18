import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunController } from "./run-controller";
import { planCollaborationDag } from "./collaboration-dag-validation";
import type { CollaborationDagDefinition } from "./collaboration-dag";
import type {
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedCollaborationRun,
  RoleDefinition,
} from "./collaboration-domain";
import type { ParticipantAssignmentPlan } from "./participant-assignment";
import type { AgentDecision, AgentTurnInput, ExternalAgentAdapter } from "./domain";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "./collaboration-transcript";
import { restorePersistedParticipants } from "../agents/participant-factory";
import { SqliteCollaborationDagPersistence } from "../persistence/sqlite-collaboration-dag-persistence";
import { SqliteCollaborationPersistence } from "../persistence/sqlite-collaboration-persistence";
import { closeDatabase, getDatabase, initDatabase } from "../persistence/database";

const NOW_ISO = "2026-09-18T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

class FakeRunStore {
  create() {}
  get() { return null; }
  update() {}
  list() { return []; }
}

class FakeSessionManager {
  async get(id: string) {
    return {
      id,
      status: "active",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
  }
  async cancel() { return true; }
}

class FakeAuditStore {
  readonly events: any[] = [];
  log(event: any) { this.events.push(event); }
}

class CountingAdapter implements ExternalAgentAdapter {
  readonly id: string;
  initializeCalls = 0;
  nextCalls = 0;
  closeCalls = 0;
  readonly inputs: AgentTurnInput[] = [];

  constructor(
    id: string,
    private readonly decision: AgentDecision | ((input: AgentTurnInput) => AgentDecision),
  ) {
    this.id = id;
  }

  async initialize(): Promise<void> {
    this.initializeCalls++;
  }

  async next(input: AgentTurnInput): Promise<AgentDecision> {
    this.nextCalls++;
    this.inputs.push(input);
    return typeof this.decision === "function" ? this.decision(input) : this.decision;
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

function role(id: string): RoleDefinition {
  return {
    id,
    name: id,
    description: `${id} role`,
    systemInstructions: `Act as ${id}`,
  };
}

function plan(
  participantId: string,
  roleId: string,
  sequenceIndex: number,
): ParticipantAssignmentPlan {
  return {
    participantId,
    roleId,
    role: role(roleId),
    adapterId: "subprocess-jsonl",
    config: {
      adapterType: "subprocess-jsonl",
      command: [`${roleId}-agent`],
      cwd: "/tmp",
    },
    sequenceIndex,
  };
}

function participantRecord(p: ParticipantAssignmentPlan): ParticipantRecord {
  return {
    id: p.participantId,
    roleId: p.roleId,
    adapterId: p.adapterId,
    status: "idle",
    turnsExecuted: 0,
    consecutiveFailures: 0,
    createdAt: NOW_ISO,
  };
}

function makeRun(
  id: string,
  sessionId: string,
  plans: readonly ParticipantAssignmentPlan[],
  overrides?: Partial<RoleBasedCollaborationRun>,
): RoleBasedCollaborationRun {
  return {
    id,
    sessionId,
    objective: "Recover a persisted P5 DAG",
    status: "running",
    round: 0,
    budget: {
      maxTurns: 10,
      maxParticipants: 5,
      maxParallelTurns: 2,
      maxRetriesPerParticipant: 1,
      maxWallClockMs: 60_000,
    },
    policy: {
      roleSequence: plans.map(p => p.roleId),
      loopMode: "once",
      terminalRoles: [plans[plans.length - 1]!.roleId],
    },
    participantIds: plans.map(p => p.participantId),
    participantsById: Object.fromEntries(plans.map(p => [p.participantId, participantRecord(p)])),
    turnHistory: [],
    createdAt: NOW_ISO,
    startedAt: NOW_ISO,
    ...overrides,
  };
}

function createSession(sessionId: string): void {
  getDatabase().prepare(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES (?, 'chatgpt-web', 'high', 'ready', ?, ?)
  `).run(sessionId, NOW_ISO, NOW_ISO);
}

function createDagRun(params: {
  persistence: SqliteCollaborationDagPersistence;
  run: RoleBasedCollaborationRun;
  plans: readonly ParticipantAssignmentPlan[];
  graph: CollaborationDagDefinition;
}): void {
  const executionPlan = planCollaborationDag(params.graph, {
    knownParticipantIds: new Set(params.plans.map(p => p.participantId)),
    budget: params.run.budget,
  });
  params.persistence.createInitialDagRun({
    run: params.run,
    plans: params.plans,
    graph: params.graph,
    plan: executionPlan,
    failurePolicy: "fail_fast",
  });
}

function controller(params: {
  dag: SqliteCollaborationDagPersistence;
  rolePersistence?: SqliteCollaborationPersistence;
  adapters?: Readonly<Record<string, CountingAdapter>>;
  audit?: FakeAuditStore;
}): RunController {
  const audit = params.audit ?? new FakeAuditStore();
  return new RunController(
    new FakeRunStore() as any,
    new FakeSessionManager() as any,
    audit as any,
    () => { throw new Error("legacy adapter factory must not run"); },
    params.rolePersistence,
    participants =>
      restorePersistedParticipants(participants, {
        locator: command => `/fake/${command}`,
        factory: config => {
          const command = config.command?.[0] ?? "";
          const adapter = params.adapters?.[command];
          if (!adapter) throw new Error(`No fake adapter for ${command}`);
          return adapter;
        },
      }),
    params.dag,
  );
}

function persistCompletedNode(params: {
  persistence: SqliteCollaborationDagPersistence;
  runId: string;
  nodeId: string;
  declarationIndex: number;
  participant: ParticipantRecord;
  roleId: string;
  content: string;
  predecessorNodeIds?: readonly string[];
  predecessorMessageIds?: readonly string[];
}): CollaborationMessageRecord {
  const turnId = `turn_${params.nodeId}`;
  const messageId = `msg_${params.nodeId}`;
  params.persistence.markNodeReady(params.runId, params.nodeId);
  params.persistence.markNodeRunningTransaction({
    runId: params.runId,
    nodeId: params.nodeId,
    participant: {
      ...params.participant,
      status: "active",
      lastActiveAt: NOW_ISO,
    },
    attempt: 1,
    startedAt: NOW_ISO,
  });

  const turn: CollaborationTurnRecord = {
    id: turnId,
    runId: params.runId,
    round: 0,
    turnIndex: params.declarationIndex * 2,
    participantId: params.participant.id,
    roleId: params.roleId,
    status: "completed",
    inputSummary: `DAG node ${params.nodeId} attempt 1`,
    decision: { type: "message", content: params.content },
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    durationMs: 1,
  };
  const message: CollaborationMessageRecord = {
    id: messageId,
    runId: params.runId,
    turnId,
    sequenceIndex: params.declarationIndex,
    senderParticipantId: params.participant.id,
    senderRoleId: params.roleId,
    decisionType: "message",
    content: params.content,
    contentHash: computeCollaborationMessageHash({
      runId: params.runId,
      turnId,
      participantId: params.participant.id,
      roleId: params.roleId,
      decisionType: "message",
      content: params.content,
    }),
    createdAt: NOW_ISO,
  };
  params.persistence.recordNodeAttemptTransaction({
    nodeId: params.nodeId,
    turn,
    message,
    provenance: {
      runId: params.runId,
      nodeId: params.nodeId,
      attempt: 1,
      turnId,
      objectiveIncluded: true,
      predecessorNodeIds: params.predecessorNodeIds ?? [],
      predecessorMessageIds: params.predecessorMessageIds ?? [],
      assembledAt: NOW_ISO,
    },
    participant: {
      ...params.participant,
      status: "idle",
      turnsExecuted: params.participant.turnsExecuted + 1,
      consecutiveFailures: 0,
      lastActiveAt: NOW_ISO,
    },
    nodeOutcome: {
      status: "completed",
      completedAt: NOW_ISO,
      outputMessageId: message.id,
    },
  });
  return message;
}

describe("P5 DAG recovery and resume", () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("P4 recovery ignores DAG-backed role runs and P5 recovery owns them", () => {
    createSession("ses_filter");
    const p = plan("part_arch", "architect", 0);
    const run = makeRun("run_filter", "ses_filter", [p]);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [{ id: "root", participantId: p.participantId, instruction: "root", dependsOn: [], terminal: true }],
    };
    const dagPersistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence: dagPersistence, run, plans: [p], graph });

    const ctrl = controller({
      dag: dagPersistence,
      rolePersistence: new SqliteCollaborationPersistence(),
    });

    expect(ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }).examined).toBe(0);
    const p5 = ctrl.recoverDagRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(p5.examined).toBe(1);
    expect(p5.pausedAtSafeBoundary).toBe(1);
    expect(dagPersistence.getRun(run.id)?.status).toBe("paused");
  });

  it("reconciles an interrupted running node without fabricating a turn or message", () => {
    createSession("ses_interrupted");
    const p = plan("part_arch", "architect", 0);
    const run = makeRun("run_interrupted", "ses_interrupted", [p]);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [{ id: "root", participantId: p.participantId, instruction: "root", dependsOn: [], terminal: true }],
    };
    const persistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence, run, plans: [p], graph });

    persistence.markNodeReady(run.id, "root");
    persistence.markNodeRunningTransaction({
      runId: run.id,
      nodeId: "root",
      participant: { ...run.participantsById[p.participantId]!, status: "active", lastActiveAt: NOW_ISO },
      attempt: 1,
      startedAt: NOW_ISO,
    });

    const report = controller({ dag: persistence }).recoverDagRuns({
      now: () => NOW_MS,
      clock: () => NOW_ISO,
    });
    expect(report.interruptedNodesReconciled).toBe(1);
    expect(persistence.getRun(run.id)?.status).toBe("paused");

    const node = persistence.getNodes(run.id)[0]!;
    expect(node.status).toBe("ready");
    expect(node.attempt).toBe(1);
    expect(node.error?.code).toBe("daemon_restarted");
    expect(persistence.getRun(run.id)?.participantsById[p.participantId]?.status).toBe("idle");
    expect(persistence.getRun(run.id)?.turnHistory).toEqual([]);
    expect(persistence.getTranscript(run.id)).toEqual([]);

    expect(
      controller({ dag: persistence }).recoverDagRuns({
        now: () => NOW_MS,
        clock: () => NOW_ISO,
      }).examined,
    ).toBe(0);
  });

  it("requires explicit acknowledgement before replaying an interrupted node", async () => {
    createSession("ses_confirm");
    const p = plan("part_arch", "architect", 0);
    const run = makeRun("run_confirm", "ses_confirm", [p]);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [{ id: "root", participantId: p.participantId, instruction: "root", dependsOn: [], terminal: true }],
    };
    const persistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence, run, plans: [p], graph });
    persistence.markNodeReady(run.id, "root");
    persistence.markNodeRunningTransaction({
      runId: run.id,
      nodeId: "root",
      participant: { ...run.participantsById[p.participantId]!, status: "active" },
      attempt: 1,
      startedAt: NOW_ISO,
    });
    const adapter = new CountingAdapter("architect", { type: "done", summary: "RECOVERED_OK" });
    const ctrl = controller({ dag: persistence, adapters: { "architect-agent": adapter } });
    ctrl.recoverDagRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    await expect(
      ctrl.resumeDagRun(run.id, { now: () => NOW_MS, clock: () => NOW_ISO }),
    ).rejects.toMatchObject({ code: "resume_replay_confirmation_required" });
    expect(adapter.initializeCalls).toBe(0);
    expect(adapter.nextCalls).toBe(0);
    expect(persistence.getRun(run.id)?.status).toBe("paused");
  });

  it("explicit replay reuses the uncommitted node attempt index and completes exactly once", async () => {
    createSession("ses_replay");
    const p = plan("part_arch", "architect", 0);
    const run = makeRun("run_replay", "ses_replay", [p]);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [{ id: "root", participantId: p.participantId, instruction: "root", dependsOn: [], terminal: true }],
    };
    const persistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence, run, plans: [p], graph });
    persistence.markNodeReady(run.id, "root");
    persistence.markNodeRunningTransaction({
      runId: run.id,
      nodeId: "root",
      participant: { ...run.participantsById[p.participantId]!, status: "active" },
      attempt: 1,
      startedAt: NOW_ISO,
    });

    const adapter = new CountingAdapter("architect", { type: "done", summary: "RECOVERED_OK" });
    const ctrl = controller({ dag: persistence, adapters: { "architect-agent": adapter } });
    ctrl.recoverDagRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    const resumed = await ctrl.resumeDagRun(run.id, {
      allowReplayInterruptedNodes: true,
      now: () => NOW_MS,
      clock: () => NOW_ISO,
    });
    expect(resumed.status).toBe("running");

    const result = await ctrl.waitForDagRun(run.id);
    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("RECOVERED_OK");
    expect(adapter.nextCalls).toBe(1);
    expect(result.nodes[0]?.attempt).toBe(1);
    expect(persistence.getRun(run.id)?.turnHistory).toHaveLength(1);
    expect(persistence.getTranscript(run.id)).toHaveLength(1);

    const second = await ctrl.waitForDagRun(run.id);
    expect(second.run.status).toBe("completed");
    expect(adapter.nextCalls).toBe(1);
  });

  it("resume never replays an already completed node", async () => {
    createSession("ses_no_replay");
    const architectPlan = plan("part_arch", "architect", 0);
    const reviewerPlan = plan("part_review", "reviewer", 1);
    const plans = [architectPlan, reviewerPlan];
    const run = makeRun("run_no_replay", "ses_no_replay", plans);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "architecture",
          participantId: architectPlan.participantId,
          instruction: "architecture",
          dependsOn: [],
        },
        {
          id: "review",
          participantId: reviewerPlan.participantId,
          instruction: "review",
          dependsOn: ["architecture"],
          terminal: true,
        },
      ],
    };
    const persistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence, run, plans, graph });

    const rootMessage = persistCompletedNode({
      persistence,
      runId: run.id,
      nodeId: "architecture",
      declarationIndex: 0,
      participant: run.participantsById[architectPlan.participantId]!,
      roleId: "architect",
      content: "ARCHITECTURE",
    });

    const architectAdapter = new CountingAdapter("architect", { type: "message", content: "MUST_NOT_RUN" });
    const reviewerAdapter = new CountingAdapter("reviewer", input => {
      expect(input.collaboration?.priorTurns.map(turn => turn.text)).toEqual(["ARCHITECTURE"]);
      expect(input.collaboration?.dag?.predecessorMessageIds).toEqual([rootMessage.id]);
      return { type: "done", summary: "REVIEW_OK" };
    });
    const ctrl = controller({
      dag: persistence,
      adapters: {
        "architect-agent": architectAdapter,
        "reviewer-agent": reviewerAdapter,
      },
    });

    const recovery = ctrl.recoverDagRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(recovery.pausedAtSafeBoundary).toBe(1);

    await ctrl.resumeDagRun(run.id, { now: () => NOW_MS, clock: () => NOW_ISO });
    const result = await ctrl.waitForDagRun(run.id);
    expect(result.run.status).toBe("completed");
    expect(architectAdapter.nextCalls).toBe(0);
    expect(reviewerAdapter.nextCalls).toBe(1);
    expect(persistence.getTranscript(run.id).map(message => message.content)).toEqual([
      "ARCHITECTURE",
      "REVIEW_OK",
    ]);
  });

  it("fails startup recovery closed when completed canonical output was tampered", () => {
    createSession("ses_corrupt");
    const architectPlan = plan("part_arch", "architect", 0);
    const reviewerPlan = plan("part_review", "reviewer", 1);
    const plans = [architectPlan, reviewerPlan];
    const run = makeRun("run_corrupt", "ses_corrupt", plans);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "architecture",
          participantId: architectPlan.participantId,
          instruction: "architecture",
          dependsOn: [],
        },
        {
          id: "review",
          participantId: reviewerPlan.participantId,
          instruction: "review",
          dependsOn: ["architecture"],
          terminal: true,
        },
      ],
    };
    const persistence = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence, run, plans, graph });
    persistCompletedNode({
      persistence,
      runId: run.id,
      nodeId: "architecture",
      declarationIndex: 0,
      participant: run.participantsById[architectPlan.participantId]!,
      roleId: "architect",
      content: "ORIGINAL",
    });

    getDatabase()
      .prepare("UPDATE collaboration_messages SET content_text = 'TAMPERED' WHERE run_id = ?")
      .run(run.id);

    expect(() =>
      controller({ dag: persistence }).recoverDagRuns({
        now: () => NOW_MS,
        clock: () => NOW_ISO,
      }),
    ).toThrow("Failed to recover DAG run");
    expect(persistence.getRun(run.id)?.status).toBe("running");
  });
});

describe("P5 real SQLite restart durability", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-dag-recovery-"));
    dbPath = path.join(tempDir, "bridge.db");
  });

  afterEach(() => {
    closeDatabase();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain a temporary SQLite handle briefly.
    }
  });

  it("reconciles an in-flight node across an actual database close/reopen", () => {
    initDatabase(dbPath);
    createSession("ses_restart");
    const p = plan("part_arch", "architect", 0);
    const run = makeRun("run_restart", "ses_restart", [p]);
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [{ id: "root", participantId: p.participantId, instruction: "root", dependsOn: [], terminal: true }],
    };
    const first = new SqliteCollaborationDagPersistence();
    createDagRun({ persistence: first, run, plans: [p], graph });
    first.markNodeReady(run.id, "root");
    first.markNodeRunningTransaction({
      runId: run.id,
      nodeId: "root",
      participant: { ...run.participantsById[p.participantId]!, status: "active" },
      attempt: 1,
      startedAt: NOW_ISO,
    });
    closeDatabase();

    initDatabase(dbPath);
    const second = new SqliteCollaborationDagPersistence();
    const report = controller({ dag: second }).recoverDagRuns({
      now: () => NOW_MS,
      clock: () => NOW_ISO,
    });

    expect(report.interruptedNodesReconciled).toBe(1);
    expect(second.getRun(run.id)?.status).toBe("paused");
    expect(second.getNodes(run.id)[0]?.status).toBe("ready");
    expect(second.getNodes(run.id)[0]?.error?.code).toBe("daemon_restarted");
    expect(second.getTranscript(run.id)).toEqual([]);
  });
});
