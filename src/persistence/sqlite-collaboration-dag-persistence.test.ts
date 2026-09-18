import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "./database";
import { SqliteCollaborationDagPersistence } from "./sqlite-collaboration-dag-persistence";
import { planCollaborationDag } from "../core/collaboration-dag-validation";
import type {
  CollaborationDagBudget,
  CollaborationDagDefinition,
  PersistedCollaborationDagInput,
} from "../core/collaboration-dag";
import type {
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedCollaborationRun,
  RunPolicy,
} from "../core/collaboration-domain";
import type { ParticipantAssignmentPlan } from "../core/participant-assignment";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "../core/collaboration-transcript";

const runId = "run_p5_sqlite";
const sessionId = "ses_p5_sqlite";

const budget: CollaborationDagBudget = {
  maxTurns: 12,
  maxParticipants: 3,
  maxParallelTurns: 2,
  maxRetriesPerParticipant: 2,
  maxWallClockMs: 300_000,
};

const policy: RunPolicy = {
  roleSequence: ["architect", "critic", "reviewer"],
  loopMode: "once",
  terminalRoles: ["reviewer"],
};

const plans: ParticipantAssignmentPlan[] = [
  {
    roleId: "architect",
    participantId: "part_arch",
    sequenceIndex: 0,
    adapterId: "acp:claude",
    role: {
      id: "architect",
      name: "Architect",
      description: "Plans",
      systemInstructions: "Plan precisely",
    },
    config: { adapterType: "acp:claude" },
  },
  {
    roleId: "critic",
    participantId: "part_critic",
    sequenceIndex: 1,
    adapterId: "acp:antigravity",
    role: {
      id: "critic",
      name: "Critic",
      description: "Critiques",
      systemInstructions: "Critique independently",
    },
    config: { adapterType: "acp:antigravity" },
  },
  {
    roleId: "reviewer",
    participantId: "part_review",
    sequenceIndex: 2,
    adapterId: "acp:claude",
    role: {
      id: "reviewer",
      name: "Reviewer",
      description: "Synthesizes",
      systemInstructions: "Synthesize evidence",
    },
    config: { adapterType: "acp:claude" },
  },
];

const participantsById: Record<string, ParticipantRecord> = Object.fromEntries(
  plans.map(plan => [
    plan.participantId,
    {
      id: plan.participantId,
      roleId: plan.roleId,
      adapterId: plan.adapterId,
      status: "pending" as const,
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: "2026-09-18T00:00:00.000Z",
    },
  ]),
);

const graph: CollaborationDagDefinition = {
  version: 1,
  nodes: [
    {
      id: "architecture",
      participantId: "part_arch",
      instruction: "Create architecture",
      dependsOn: [],
    },
    {
      id: "critique",
      participantId: "part_critic",
      instruction: "Critique architecture",
      dependsOn: ["architecture"],
    },
    {
      id: "review",
      participantId: "part_review",
      instruction: "Review both outputs",
      dependsOn: ["architecture", "critique"],
      terminal: true,
    },
  ],
};

const plan = planCollaborationDag(graph, {
  knownParticipantIds: new Set(plans.map(item => item.participantId)),
  budget,
});

function initialRun(): RoleBasedCollaborationRun {
  return {
    id: runId,
    sessionId,
    objective: "Verify P5 SQLite DAG durability",
    status: "running",
    round: 0,
    budget,
    policy,
    participantIds: plans.map(item => item.participantId),
    participantsById: structuredClone(participantsById),
    turnHistory: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    startedAt: "2026-09-18T00:00:00.000Z",
  };
}

function architectCompletion() {
  const turn: CollaborationTurnRecord = {
    id: "cturn_arch_1",
    runId,
    round: 0,
    turnIndex: 0,
    participantId: "part_arch",
    roleId: "architect",
    status: "completed",
    inputSummary: "DAG node architecture attempt 1",
    decision: { type: "message", content: "Architecture output" },
    startedAt: "2026-09-18T00:00:01.000Z",
    completedAt: "2026-09-18T00:00:02.000Z",
    durationMs: 1000,
  };

  const message: CollaborationMessageRecord = {
    id: "cmsg_arch",
    runId,
    turnId: turn.id,
    sequenceIndex: 0,
    senderParticipantId: "part_arch",
    senderRoleId: "architect",
    decisionType: "message",
    content: "Architecture output",
    contentHash: computeCollaborationMessageHash({
      runId,
      turnId: turn.id,
      participantId: "part_arch",
      roleId: "architect",
      decisionType: "message",
      content: "Architecture output",
    }),
    createdAt: "2026-09-18T00:00:02.000Z",
  };

  const provenance: PersistedCollaborationDagInput = {
    runId,
    nodeId: "architecture",
    attempt: 1,
    turnId: turn.id,
    objectiveIncluded: true,
    predecessorNodeIds: [],
    predecessorMessageIds: [],
    assembledAt: "2026-09-18T00:00:01.000Z",
  };

  const participant: ParticipantRecord = {
    ...participantsById.part_arch!,
    status: "idle",
    turnsExecuted: 1,
    consecutiveFailures: 0,
    lastActiveAt: "2026-09-18T00:00:02.000Z",
  };

  return { turn, message, provenance, participant };
}

beforeEach(() => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES (
      '${sessionId}', 'chatgpt-web', 'high', 'ready',
      '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z'
    );
  `);
});

afterEach(() => {
  closeDatabase();
});

test("P5 SQLite persistence creates run, participants, graph metadata, nodes, and dependencies atomically", () => {
  const persistence = new SqliteCollaborationDagPersistence();
  persistence.createInitialDagRun({
    run: initialRun(),
    plans,
    graph,
    plan,
    failurePolicy: "fail_fast",
  });

  const restoredRun = persistence.getRun(runId);
  expect(restoredRun).not.toBeNull();
  expect(restoredRun!.budget.maxParallelTurns).toBe(2);
  expect(restoredRun!.participantIds).toEqual(["part_arch", "part_critic", "part_review"]);

  const metadata = persistence.getMetadata(runId);
  expect(metadata).not.toBeNull();
  expect(metadata!.failurePolicy).toBe("fail_fast");
  expect(metadata!.maxParallelTurns).toBe(2);
  expect(metadata!.graph).toEqual(graph);

  const nodes = persistence.getNodes(runId);
  expect(nodes.map(node => [node.id, node.status])).toEqual([
    ["architecture", "pending"],
    ["critique", "pending"],
    ["review", "pending"],
  ]);
  expect(nodes.find(node => node.id === "review")?.roleId).toBe("reviewer");
});

test("P5 SQLite persistence atomically commits canonical output, provenance, participant, and node completion", () => {
  const persistence = new SqliteCollaborationDagPersistence();
  persistence.createInitialDagRun({
    run: initialRun(),
    plans,
    graph,
    plan,
    failurePolicy: "fail_fast",
  });

  persistence.markNodeReady(runId, "architecture");
  persistence.markNodeRunningTransaction({
    runId,
    nodeId: "architecture",
    participant: {
      ...participantsById.part_arch!,
      status: "active",
      lastActiveAt: "2026-09-18T00:00:01.000Z",
    },
    attempt: 1,
    startedAt: "2026-09-18T00:00:01.000Z",
  });

  const completion = architectCompletion();
  persistence.recordNodeAttemptTransaction({
    nodeId: "architecture",
    ...completion,
    nodeOutcome: {
      status: "completed",
      completedAt: "2026-09-18T00:00:02.000Z",
      outputMessageId: completion.message.id,
    },
  });

  const node = persistence.getNodes(runId).find(item => item.id === "architecture");
  expect(node?.status).toBe("completed");
  expect(node?.attempt).toBe(1);
  expect(node?.outputMessageId).toBe("cmsg_arch");

  expect(persistence.getTranscript(runId).map(item => item.id)).toEqual(["cmsg_arch"]);
  expect(persistence.getInputs(runId, "architecture")).toEqual([completion.provenance]);
  expect(persistence.getMessagesByNode(runId).architecture?.content).toBe("Architecture output");

  const restoredRun = persistence.getRun(runId)!;
  expect(restoredRun.turnHistory).toEqual(["cturn_arch_1"]);
  expect(restoredRun.participantsById.part_arch?.turnsExecuted).toBe(1);
  expect(restoredRun.participantsById.part_arch?.status).toBe("idle");
});

test("P5 SQLite node completion transaction rolls back every write if output binding is inconsistent", () => {
  const persistence = new SqliteCollaborationDagPersistence();
  persistence.createInitialDagRun({
    run: initialRun(),
    plans,
    graph,
    plan,
    failurePolicy: "fail_fast",
  });
  persistence.markNodeReady(runId, "architecture");
  persistence.markNodeRunningTransaction({
    runId,
    nodeId: "architecture",
    participant: {
      ...participantsById.part_arch!,
      status: "active",
      lastActiveAt: "2026-09-18T00:00:01.000Z",
    },
    attempt: 1,
    startedAt: "2026-09-18T00:00:01.000Z",
  });

  const completion = architectCompletion();
  expect(() =>
    persistence.recordNodeAttemptTransaction({
      nodeId: "architecture",
      ...completion,
      nodeOutcome: {
        status: "completed",
        completedAt: "2026-09-18T00:00:02.000Z",
        outputMessageId: "cmsg_wrong",
      },
    }),
  ).toThrow();

  expect(persistence.getTranscript(runId)).toEqual([]);
  expect(persistence.getInputs(runId, "architecture")).toEqual([]);
  expect(persistence.getRun(runId)?.turnHistory).toEqual([]);

  const node = persistence.getNodes(runId).find(item => item.id === "architecture");
  expect(node?.status).toBe("running");
  expect(node?.outputMessageId).toBeUndefined();

  const participant = persistence.getRun(runId)?.participantsById.part_arch;
  expect(participant?.status).toBe("active");
  expect(participant?.turnsExecuted).toBe(0);
});

test("P5 SQLite node terminal state is immutable", () => {
  const persistence = new SqliteCollaborationDagPersistence();
  persistence.createInitialDagRun({
    run: initialRun(),
    plans,
    graph,
    plan,
    failurePolicy: "fail_fast",
  });
  persistence.markNodeReady(runId, "architecture");
  persistence.markNodeRunningTransaction({
    runId,
    nodeId: "architecture",
    participant: {
      ...participantsById.part_arch!,
      status: "active",
    },
    attempt: 1,
    startedAt: "2026-09-18T00:00:01.000Z",
  });

  const completion = architectCompletion();
  persistence.recordNodeAttemptTransaction({
    nodeId: "architecture",
    ...completion,
    nodeOutcome: {
      status: "completed",
      completedAt: "2026-09-18T00:00:02.000Z",
      outputMessageId: completion.message.id,
    },
  });

  expect(() => persistence.markNodeReady(runId, "architecture")).toThrow();
  expect(persistence.getNodes(runId).find(item => item.id === "architecture")?.status).toBe("completed");
});
