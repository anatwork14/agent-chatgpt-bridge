import { expect, test, beforeEach, afterEach } from "bun:test";
import { initDatabase, closeDatabase, getDatabase } from "./database";
import { SqliteCollaborationPersistence } from "./sqlite-collaboration-persistence";
import type {
  RoleBasedCollaborationRun,
  RoleBasedRunBudget,
  RunPolicy,
  CollaborationTurnRecord,
  ParticipantRecord,
} from "../core/collaboration-domain";
import type { ParticipantAssignmentPlan } from "../core/participant-assignment";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "../core/collaboration-transcript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

beforeEach(() => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_p4_durability', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
  `);
});

afterEach(() => {
  closeDatabase();
});

const defaultBudget: RoleBasedRunBudget = {
  maxTurns: 10,
  maxParticipants: 3,
  maxParallelTurns: 1,
  maxRetriesPerParticipant: 2,
  maxWallClockMs: 300_000,
};

const defaultPolicy: RunPolicy = {
  roleSequence: ["architect", "implementer", "reviewer"],
  loopMode: "once",
  terminalRoles: ["reviewer"],
};

test("SqliteCollaborationPersistence: full round-trip across run, participants, turns, and messages", () => {
  const persistence = new SqliteCollaborationPersistence();
  const runId = "run_full_rt";

  const plans: ParticipantAssignmentPlan[] = [
    {
      roleId: "architect",
      participantId: "part_arch",
      sequenceIndex: 0,
      adapterId: "acp:claude",
      role: {
        id: "architect",
        name: "System Architect",
        description: "Designs system architecture",
        systemInstructions: "Be precise",
      },
      config: { adapterType: "acp", cwd: "/tmp" },
    },
    {
      roleId: "implementer",
      participantId: "part_impl",
      sequenceIndex: 1,
      adapterId: "subprocess-jsonl",
      role: {
        id: "implementer",
        name: "Code Implementer",
        description: "Implements code",
        systemInstructions: "Be concise",
      },
      config: { adapterType: "subprocess", cwd: "/tmp" },
    },
  ];

  const initialParticipants: Record<string, ParticipantRecord> = {
    part_arch: {
      id: "part_arch",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "idle",
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    },
    part_impl: {
      id: "part_impl",
      roleId: "implementer",
      adapterId: "subprocess-jsonl",
      status: "idle",
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    },
  };

  const run: RoleBasedCollaborationRun = {
    id: runId,
    sessionId: "ses_p4_durability",
    objective: "Verify end-to-end SQLite collaboration persistence",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: ["part_arch", "part_impl"],
    participantsById: initialParticipants,
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
    startedAt: "2026-09-17T00:00:00Z",
  };

  // 1. Create initial run
  persistence.createInitialRun(run, plans);

  const initialFetched = persistence.getRun(runId);
  expect(initialFetched).not.toBeNull();
  expect(initialFetched!.status).toBe("running");
  expect(initialFetched!.participantIds).toEqual(["part_arch", "part_impl"]);
  expect(initialFetched!.participantsById.part_arch!.status).toBe("idle");

  // 2. Commit turn 0 transaction (architect message)
  const turn0: CollaborationTurnRecord = {
    id: "cturn_0",
    runId,
    round: 0,
    turnIndex: 0,
    participantId: "part_arch",
    roleId: "architect",
    status: "completed",
    inputSummary: "Architectural turn",
    decision: { type: "message", content: "Architecture Plan v1" },
    startedAt: "2026-09-17T00:00:00Z",
    completedAt: "2026-09-17T00:00:03Z",
    durationMs: 3000,
  };

  const msg0: CollaborationMessageRecord = {
    id: "cmsg_0",
    runId,
    turnId: "cturn_0",
    sequenceIndex: 0,
    senderParticipantId: "part_arch",
    senderRoleId: "architect",
    decisionType: "message",
    content: "Architecture Plan v1",
    contentHash: computeCollaborationMessageHash({
      runId,
      turnId: "cturn_0",
      participantId: "part_arch",
      roleId: "architect",
      decisionType: "message",
      content: "Architecture Plan v1",
    }),
    createdAt: "2026-09-17T00:00:03Z",
  };

  const updatedArch: ParticipantRecord = {
    ...initialParticipants.part_arch!,
    status: "idle",
    turnsExecuted: 1,
    lastActiveAt: "2026-09-17T00:00:03Z",
  };

  persistence.recordTurnTransaction({
    turn: turn0,
    message: msg0,
    participant: updatedArch,
    runUpdates: { id: runId, round: 0 },
  });

  // Verify state after turn 0
  const postTurn0 = persistence.getRun(runId);
  expect(postTurn0!.turnHistory).toEqual(["cturn_0"]);
  expect(postTurn0!.participantsById.part_arch!.turnsExecuted).toBe(1);

  const transcript = persistence.getTranscript(runId);
  expect(transcript.length).toBe(1);
  expect(transcript[0]!.content).toBe("Architecture Plan v1");
  expect(transcript[0]!.senderRoleId).toBe("architect");
});

test("SqliteCollaborationPersistence: atomic transaction rollback on failure", () => {
  const persistence = new SqliteCollaborationPersistence();
  const runId = "run_rollback_test";

  const plans: ParticipantAssignmentPlan[] = [
    {
      roleId: "architect",
      participantId: "part_rb_arch",
      sequenceIndex: 0,
      adapterId: "acp:claude",
      role: { id: "architect", name: "Arch", description: "", systemInstructions: "" },
      config: { adapterType: "acp" },
    },
  ];

  const initialParticipants: Record<string, ParticipantRecord> = {
    part_rb_arch: {
      id: "part_rb_arch",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "idle",
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    },
  };

  persistence.createInitialRun(
    {
      id: runId,
      sessionId: "ses_p4_durability",
      objective: "Test rollback",
      status: "running",
      round: 0,
      budget: defaultBudget,
      policy: defaultPolicy,
      participantIds: ["part_rb_arch"],
      participantsById: initialParticipants,
      turnHistory: [],
      createdAt: "2026-09-17T00:00:00Z",
    },
    plans,
  );

  const turn: CollaborationTurnRecord = {
    id: "cturn_rb",
    runId,
    round: 0,
    turnIndex: 0,
    participantId: "part_rb_arch",
    roleId: "architect",
    status: "completed",
    inputSummary: "Plan",
    decision: { type: "message", content: "Valid text" },
    startedAt: "2026-09-17T00:00:00Z",
  };

  // Provide message with forged hash to trigger error during transaction
  const invalidMessage: CollaborationMessageRecord = {
    id: "cmsg_rb",
    runId,
    turnId: "cturn_rb",
    sequenceIndex: 0,
    senderParticipantId: "part_rb_arch",
    senderRoleId: "architect",
    decisionType: "message",
    content: "Valid text",
    contentHash: "tampered_hash_value",
    createdAt: "2026-09-17T00:00:01Z",
  };

  const updatedArch: ParticipantRecord = {
    ...initialParticipants.part_rb_arch!,
    turnsExecuted: 1,
  };

  // The transaction should fail and throw
  expect(() => {
    persistence.recordTurnTransaction({
      turn,
      message: invalidMessage,
      participant: updatedArch,
      runUpdates: { id: runId, round: 0 },
    });
  }).toThrow();

  // Verify complete rollback: turn absent, message absent, participant unchanged, run unchanged
  const afterFailure = persistence.getRun(runId);
  expect(afterFailure!.turnHistory).toEqual([]);
  expect(afterFailure!.participantsById.part_rb_arch!.turnsExecuted).toBe(0);

  const rawTurns = getDatabase()
    .query("SELECT * FROM collaboration_turns WHERE run_id = ?")
    .all(runId);
  expect(rawTurns.length).toBe(0);

  const rawMessages = getDatabase()
    .query("SELECT * FROM collaboration_messages WHERE run_id = ?")
    .all(runId);
  expect(rawMessages.length).toBe(0);
});

test("SqliteCollaborationPersistence: tamper detection triggers integrity failure", () => {
  const persistence = new SqliteCollaborationPersistence();
  const runId = "run_tamper_test";

  const plans: ParticipantAssignmentPlan[] = [
    {
      roleId: "architect",
      participantId: "part_tamper",
      sequenceIndex: 0,
      adapterId: "acp:claude",
      role: { id: "architect", name: "Arch", description: "", systemInstructions: "" },
      config: { adapterType: "acp" },
    },
  ];

  persistence.createInitialRun(
    {
      id: runId,
      sessionId: "ses_p4_durability",
      objective: "Tamper test",
      status: "running",
      round: 0,
      budget: defaultBudget,
      policy: defaultPolicy,
      participantIds: ["part_tamper"],
      participantsById: {
        part_tamper: {
          id: "part_tamper",
          roleId: "architect",
          adapterId: "acp:claude",
          status: "idle",
          turnsExecuted: 0,
          consecutiveFailures: 0,
          createdAt: "2026-09-17T00:00:00Z",
        },
      },
      turnHistory: [],
      createdAt: "2026-09-17T00:00:00Z",
    },
    plans,
  );

  const validContent = "Official untampered architectural specification";
  const validHash = computeCollaborationMessageHash({
    runId,
    turnId: "cturn_tamper",
    participantId: "part_tamper",
    roleId: "architect",
    decisionType: "message",
    content: validContent,
  });

  persistence.recordTurnTransaction({
    turn: {
      id: "cturn_tamper",
      runId,
      round: 0,
      turnIndex: 0,
      participantId: "part_tamper",
      roleId: "architect",
      status: "completed",
      inputSummary: "Turn",
      decision: { type: "message", content: validContent },
      startedAt: "2026-09-17T00:00:00Z",
    },
    message: {
      id: "cmsg_tamper",
      runId,
      turnId: "cturn_tamper",
      sequenceIndex: 0,
      senderParticipantId: "part_tamper",
      senderRoleId: "architect",
      decisionType: "message",
      content: validContent,
      contentHash: validHash,
      createdAt: "2026-09-17T00:00:01Z",
    },
    participant: {
      id: "part_tamper",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "idle",
      turnsExecuted: 1,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    },
    runUpdates: { id: runId },
  });

  // Verify transcript loads cleanly before tamper
  const pristineTranscript = persistence.getTranscript(runId);
  expect(pristineTranscript.length).toBe(1);

  // Directly tamper with SQLite content_text
  getDatabase().prepare(`
    UPDATE collaboration_messages SET content_text = 'Malicious injected content'
    WHERE id = 'cmsg_tamper'
  `).run();

  // Attempting to read transcript must fail closed with integrity check error
  expect(() => {
    persistence.getTranscript(runId);
  }).toThrow();
});

test("SqliteCollaborationPersistence: updateParticipantAndRunTransaction updates participant and run atomically", () => {
  const persistence = new SqliteCollaborationPersistence();
  const runId = "run_update_trans";

  const plans: ParticipantAssignmentPlan[] = [
    {
      roleId: "architect",
      participantId: "part_arch",
      sequenceIndex: 0,
      adapterId: "acp:claude",
      role: { id: "architect", name: "Architect", description: "", systemInstructions: "" },
      config: { adapterType: "acp" },
    },
  ];

  persistence.createInitialRun(
    {
      id: runId,
      sessionId: "ses_p4_durability",
      objective: "Test atomic participant/run update",
      status: "running",
      round: 0,
      budget: defaultBudget,
      policy: defaultPolicy,
      participantIds: ["part_arch"],
      participantsById: {
        part_arch: {
          id: "part_arch",
          roleId: "architect",
          adapterId: "acp:claude",
          status: "idle",
          turnsExecuted: 0,
          consecutiveFailures: 0,
          createdAt: "2026-09-17T00:00:00Z",
        },
      },
      turnHistory: [],
      createdAt: "2026-09-17T00:00:00Z",
    },
    plans,
  );

  persistence.updateParticipantAndRunTransaction({
    participant: {
      id: "part_arch",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "active",
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
      lastActiveAt: "2026-09-17T00:00:01Z",
    },
    runUpdates: {
      id: runId,
      activeParticipantId: "part_arch",
    },
  });

  const updatedRun = persistence.getRun(runId);
  expect(updatedRun).not.toBeNull();
  expect(updatedRun!.activeParticipantId).toBe("part_arch");
  expect(updatedRun!.participantsById.part_arch!.status).toBe("active");
  expect(updatedRun!.participantsById.part_arch!.lastActiveAt).toBe("2026-09-17T00:00:01Z");
});

test("SqliteCollaborationPersistence: disk restart durability with temporary SQLite file", () => {
  closeDatabase();
  const diskDbPath = path.join(
    os.tmpdir(),
    `test-p4-durability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = initDatabase(diskDbPath);
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_p4_durability', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
  `);

  try {
    const persistence1 = new SqliteCollaborationPersistence();
    const runId = "run_disk_restart";

    const plans: ParticipantAssignmentPlan[] = [
      {
        roleId: "reviewer",
        participantId: "part_rev",
        sequenceIndex: 0,
        adapterId: "acp:claude",
        role: { id: "reviewer", name: "Reviewer", description: "", systemInstructions: "" },
        config: { adapterType: "acp" },
      },
    ];

    persistence1.createInitialRun(
      {
        id: runId,
        sessionId: "ses_p4_durability",
        objective: "Verify disk durability",
        status: "running",
        round: 0,
        budget: defaultBudget,
        policy: defaultPolicy,
        participantIds: ["part_rev"],
        participantsById: {
          part_rev: {
            id: "part_rev",
            roleId: "reviewer",
            adapterId: "acp:claude",
            status: "idle",
            turnsExecuted: 0,
            consecutiveFailures: 0,
            createdAt: "2026-09-17T00:00:00Z",
          },
        },
        turnHistory: [],
        createdAt: "2026-09-17T00:00:00Z",
      },
      plans,
    );

    const decisionContent = "APPROVED: All acceptance tests passed.";
    const decisionHash = computeCollaborationMessageHash({
      runId,
      turnId: "cturn_rev_0",
      participantId: "part_rev",
      roleId: "reviewer",
      decisionType: "done",
      content: decisionContent,
    });

    persistence1.recordTurnTransaction({
      turn: {
        id: "cturn_rev_0",
        runId,
        round: 0,
        turnIndex: 0,
        participantId: "part_rev",
        roleId: "reviewer",
        status: "completed",
        inputSummary: "Review turn",
        decision: { type: "done", summary: decisionContent },
        startedAt: "2026-09-17T00:00:00Z",
        completedAt: "2026-09-17T00:00:05Z",
        durationMs: 5000,
      },
      message: {
        id: "cmsg_rev_0",
        runId,
        turnId: "cturn_rev_0",
        sequenceIndex: 0,
        senderParticipantId: "part_rev",
        senderRoleId: "reviewer",
        decisionType: "done",
        content: decisionContent,
        contentHash: decisionHash,
        createdAt: "2026-09-17T00:00:05Z",
      },
      participant: {
        id: "part_rev",
        roleId: "reviewer",
        adapterId: "acp:claude",
        status: "idle",
        turnsExecuted: 1,
        consecutiveFailures: 0,
        createdAt: "2026-09-17T00:00:00Z",
        lastActiveAt: "2026-09-17T00:00:05Z",
      },
      runUpdates: {
        id: runId,
        status: "completed",
        finalSummary: decisionContent,
        completedAt: "2026-09-17T00:00:05Z",
      },
    });

    // Now simulate daemon stop / crash: close database
    closeDatabase();

    // Re-open database from disk path
    initDatabase(diskDbPath);
    const persistence2 = new SqliteCollaborationPersistence();

    const restoredRun = persistence2.getRun(runId);
    expect(restoredRun).not.toBeNull();
    expect(restoredRun!.id).toBe(runId);
    expect(restoredRun!.status).toBe("completed");
    expect(restoredRun!.finalSummary).toBe(decisionContent);
    expect(restoredRun!.completedAt).toBe("2026-09-17T00:00:05Z");
    expect(restoredRun!.turnHistory).toEqual(["cturn_rev_0"]);
    expect(restoredRun!.participantIds).toEqual(["part_rev"]);
    expect(restoredRun!.participantsById.part_rev!.turnsExecuted).toBe(1);

    const restoredTranscript = persistence2.getTranscript(runId);
    expect(restoredTranscript.length).toBe(1);
    expect(restoredTranscript[0]!.content).toBe(decisionContent);
    expect(restoredTranscript[0]!.decisionType).toBe("done");
    expect(restoredTranscript[0]!.senderRoleId).toBe("reviewer");
  } finally {
    closeDatabase();
    for (const p of [diskDbPath, diskDbPath + "-wal", diskDbPath + "-shm"]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Lingering file locks on Windows temporary test files are safely ignored
      }
    }
  }
});
