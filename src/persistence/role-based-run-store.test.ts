import { expect, test, beforeEach, afterEach } from "bun:test";
import { initDatabase, closeDatabase, getDatabase } from "./database";
import { RoleBasedRunStore } from "./role-based-run-store";
import { CollaborationParticipantStore } from "./collaboration-participant-store";
import { CollaborationTurnStore } from "./collaboration-turn-store";
import { CollaborationMessageStore } from "./collaboration-message-store";
import {
  type RoleBasedCollaborationRun,
  type RoleBasedRunBudget,
  type RunPolicy,
  ROLE_BASED_TERMINAL_STATUSES,
} from "../core/collaboration-domain";
import type { ParticipantAssignmentPlan } from "../core/participant-assignment";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "../core/collaboration-transcript";
import { BridgeError } from "../core/errors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

beforeEach(() => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_store_test', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
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

test("RoleBasedRunStore full lifecycle: create, get, update, listBySession", () => {
  const runStore = new RoleBasedRunStore();
  const runId = "run_store_1";

  const run: RoleBasedCollaborationRun = {
    id: runId,
    sessionId: "ses_store_test",
    objective: "Implement durable persistence",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
    startedAt: "2026-09-17T00:00:00Z",
  };

  runStore.create(run);

  const fetched = runStore.get(runId);
  expect(fetched).not.toBeNull();
  expect(fetched!.id).toBe(runId);
  expect(fetched!.sessionId).toBe("ses_store_test");
  expect(fetched!.objective).toBe("Implement durable persistence");
  expect(fetched!.status).toBe("running");
  expect(fetched!.budget.maxTurns).toBe(10);
  expect(fetched!.policy.roleSequence).toEqual(["architect", "implementer", "reviewer"]);

  // Update status and finalSummary
  runStore.update(runId, {
    status: "completed",
    finalSummary: "Successfully verified and approved",
    completedAt: "2026-09-17T00:01:00Z",
  });

  const updated = runStore.get(runId);
  expect(updated!.status).toBe("completed");
  expect(updated!.finalSummary).toBe("Successfully verified and approved");
  expect(updated!.completedAt).toBe("2026-09-17T00:01:00Z");

  const list = runStore.listBySession("ses_store_test");
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe(runId);
});

test("CollaborationParticipantStore stores sanitized config and prevents credential persistence", () => {
  const runStore = new RoleBasedRunStore();
  const partStore = new CollaborationParticipantStore();
  const runId = "run_part_test";

  runStore.create({
    id: runId,
    sessionId: "ses_store_test",
    objective: "Test participant storage",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
  });

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
        systemInstructions: "Formulate rigorous design specs",
      },
      config: {
        adapterType: "acp",
        cwd: "/tmp/project",
        config: {
          profile: "claude-3-7-sonnet",
          permissionMode: "allow_readonly",
          // Sensitive values that MUST be stripped:
          apiKey: "sk-secret-key",
          token: "dummy_secret_token_123",
          password: "supersecretpassword",
        } as any,
      },
    },
    {
      roleId: "implementer",
      participantId: "part_impl",
      sequenceIndex: 1,
      adapterId: "subprocess-jsonl",
      role: {
        id: "implementer",
        name: "Code Implementer",
        description: "Writes implementation",
        systemInstructions: "Produce minimal correct diffs",
      },
      config: {
        adapterType: "subprocess-jsonl",
        command: ["bun", "agent.js"],
        cwd: "/tmp/project",
      },
    },
  ];

  partStore.createMany(runId, plans, {
    participantIds: ["part_arch", "part_impl"],
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
      part_impl: {
        id: "part_impl",
        roleId: "implementer",
        adapterId: "subprocess-jsonl",
        status: "idle",
        turnsExecuted: 0,
        consecutiveFailures: 0,
        createdAt: "2026-09-17T00:00:00Z",
      },
    },
  });

  const list = partStore.listByRun(runId);
  expect(list.length).toBe(2);
  expect(list[0]!.id).toBe("part_arch");
  expect(list[1]!.id).toBe("part_impl");
  expect(list[0]!.sequenceIndex).toBe(0);
  expect(list[1]!.sequenceIndex).toBe(1);

  // Assert config snapshot is sanitized:
  const archConfig = list[0]!.configSnapshot as any;
  expect(archConfig.adapterType).toBe("acp");
  expect(archConfig.config.profile).toBe("claude-3-7-sonnet");
  expect(archConfig.config.permissionMode).toBe("allow_readonly");
  expect(archConfig.config.apiKey).toBeUndefined();
  expect(archConfig.config.token).toBeUndefined();
  expect(archConfig.config.password).toBeUndefined();

  // Test participant update
  partStore.update("part_arch", {
    status: "active",
    turnsExecuted: 1,
    lastActiveAt: "2026-09-17T00:01:00Z",
  });
  const updatedArch = partStore.get("part_arch");
  expect(updatedArch!.status).toBe("active");
  expect(updatedArch!.turnsExecuted).toBe(1);
  expect(updatedArch!.lastActiveAt).toBe("2026-09-17T00:01:00Z");
});

test("CollaborationTurnStore enforces turn_index ordering and unique constraint", () => {
  const runStore = new RoleBasedRunStore();
  const partStore = new CollaborationParticipantStore();
  const turnStore = new CollaborationTurnStore();
  const runId = "run_turn_test";

  runStore.create({
    id: runId,
    sessionId: "ses_store_test",
    objective: "Test turns",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
  });

  partStore.createMany(
    runId,
    [
      {
        roleId: "architect",
        participantId: "part_turn_1",
        sequenceIndex: 0,
        adapterId: "acp:mock",
        role: {
          id: "architect",
          name: "Architect",
          description: "",
          systemInstructions: "",
        },
        config: { adapterType: "mock" },
      },
    ],
    {
      participantIds: ["part_turn_1"],
      participantsById: {
        part_turn_1: {
          id: "part_turn_1",
          roleId: "architect",
          adapterId: "acp:mock",
          status: "idle",
          turnsExecuted: 0,
          consecutiveFailures: 0,
          createdAt: "2026-09-17T00:00:00Z",
        },
      },
    },
  );

  turnStore.create({
    id: "cturn_0",
    runId,
    round: 0,
    turnIndex: 0,
    participantId: "part_turn_1",
    roleId: "architect",
    status: "completed",
    inputSummary: "Design specs",
    decision: { type: "message", content: "Plan drafted" },
    startedAt: "2026-09-17T00:00:00Z",
    completedAt: "2026-09-17T00:00:05Z",
    durationMs: 5000,
  });

  const turn = turnStore.get("cturn_0");
  expect(turn).not.toBeNull();
  expect(turn!.id).toBe("cturn_0");
  expect(turn!.decision).toEqual({ type: "message", content: "Plan drafted" });
  expect(turn!.durationMs).toBe(5000);

  // Duplicate turnIndex on same run must fail UNIQUE constraint
  expect(() => {
    turnStore.create({
      id: "cturn_duplicate",
      runId,
      round: 0,
      turnIndex: 0,
      participantId: "part_turn_1",
      roleId: "architect",
      status: "completed",
      inputSummary: "Another plan",
      startedAt: "2026-09-17T00:00:06Z",
    });
  }).toThrow();
});

test("CollaborationMessageStore enforces SHA-256 integrity and sequence_index ordering", () => {
  const runStore = new RoleBasedRunStore();
  const partStore = new CollaborationParticipantStore();
  const turnStore = new CollaborationTurnStore();
  const msgStore = new CollaborationMessageStore();
  const runId = "run_msg_test";

  runStore.create({
    id: runId,
    sessionId: "ses_store_test",
    objective: "Test messages",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
  });

  partStore.createMany(
    runId,
    [
      {
        roleId: "architect",
        participantId: "part_msg_1",
        sequenceIndex: 0,
        adapterId: "acp:mock",
        role: {
          id: "architect",
          name: "Architect",
          description: "",
          systemInstructions: "",
        },
        config: { adapterType: "mock" },
      },
    ],
    {
      participantIds: ["part_msg_1"],
      participantsById: {
        part_msg_1: {
          id: "part_msg_1",
          roleId: "architect",
          adapterId: "acp:mock",
          status: "idle",
          turnsExecuted: 0,
          consecutiveFailures: 0,
          createdAt: "2026-09-17T00:00:00Z",
        },
      },
    },
  );

  turnStore.create({
    id: "cturn_msg_0",
    runId,
    round: 0,
    turnIndex: 0,
    participantId: "part_msg_1",
    roleId: "architect",
    status: "completed",
    inputSummary: "Summary",
    startedAt: "2026-09-17T00:00:00Z",
  });

  const content = "Architectural decision payload with \r\n CRLF";
  const validHash = computeCollaborationMessageHash({
    runId,
    turnId: "cturn_msg_0",
    participantId: "part_msg_1",
    roleId: "architect",
    decisionType: "message",
    content,
  });

  const msgRecord: CollaborationMessageRecord = {
    id: "cmsg_0",
    runId,
    turnId: "cturn_msg_0",
    sequenceIndex: 0,
    senderParticipantId: "part_msg_1",
    senderRoleId: "architect",
    decisionType: "message",
    content,
    contentHash: validHash,
    createdAt: "2026-09-17T00:00:05Z",
  };

  msgStore.create(msgRecord);

  const retrieved = msgStore.get("cmsg_0");
  expect(retrieved).not.toBeNull();
  expect(retrieved!.content).toBe(content);
  expect(retrieved!.contentHash).toBe(validHash);

  // Creating message with forged/tampered hash must fail closed
  expect(() => {
    msgStore.create({
      ...msgRecord,
      id: "cmsg_tampered",
      sequenceIndex: 1,
      contentHash: "forged_sha256_hash",
    });
  }).toThrow();

  // Duplicate sequence_index must fail UNIQUE constraint
  expect(() => {
    msgStore.create({
      ...msgRecord,
      id: "cmsg_dup_seq",
      sequenceIndex: 0,
    });
  }).toThrow();
});

test("RoleBasedRunStore.update patch semantics: concrete vs null vs omitted", () => {
  const runStore = new RoleBasedRunStore();
  const runId = "run_patch_test_1";

  runStore.create({
    id: runId,
    sessionId: "ses_store_test",
    objective: "Test SQLite patch semantics",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
    activeParticipantId: "part_active",
    finalSummary: "Initial summary text",
    completedAt: "2026-09-17T00:01:00Z",
  });

  const initial = runStore.get(runId);
  expect(initial?.activeParticipantId).toBe("part_active");
  expect(initial?.finalSummary).toBe("Initial summary text");
  expect(initial?.completedAt).toBe("2026-09-17T00:01:00Z");

  // 1. Omitted fields remain untouched while updated fields change
  runStore.update(runId, {
    round: 1,
  });
  const afterRoundUpdate = runStore.get(runId);
  expect(afterRoundUpdate?.round).toBe(1);
  expect(afterRoundUpdate?.activeParticipantId).toBe("part_active");
  expect(afterRoundUpdate?.finalSummary).toBe("Initial summary text");
  expect(afterRoundUpdate?.completedAt).toBe("2026-09-17T00:01:00Z");

  // 2. Explicit null clears activeParticipantId without wiping finalSummary or completedAt
  runStore.update(runId, {
    activeParticipantId: null,
  });
  const afterActiveNull = runStore.get(runId);
  expect(afterActiveNull?.activeParticipantId).toBeUndefined();
  expect(afterActiveNull?.finalSummary).toBe("Initial summary text");
  expect(afterActiveNull?.completedAt).toBe("2026-09-17T00:01:00Z");

  const rawRow2 = getDatabase()
    .prepare("SELECT active_participant_id, final_summary, completed_at FROM role_based_runs WHERE id = ?")
    .get(runId) as any;
  expect(rawRow2.active_participant_id).toBeNull();
  expect(rawRow2.final_summary).toBe("Initial summary text");
  expect(rawRow2.completed_at).toBe("2026-09-17T00:01:00Z");

  // 3. Explicit null clears finalSummary and completedAt
  runStore.update(runId, {
    finalSummary: null,
    completedAt: null,
  });
  const afterAllNull = runStore.get(runId);
  expect(afterAllNull?.finalSummary).toBeUndefined();
  expect(afterAllNull?.completedAt).toBeUndefined();

  const rawRow3 = getDatabase()
    .prepare("SELECT active_participant_id, final_summary, completed_at FROM role_based_runs WHERE id = ?")
    .get(runId) as any;
  expect(rawRow3.active_participant_id).toBeNull();
  expect(rawRow3.final_summary).toBeNull();
  expect(rawRow3.completed_at).toBeNull();

  // 4. Concrete value sets activeParticipantId again
  runStore.update(runId, {
    activeParticipantId: "part_new_active",
  });
  const afterNewActive = runStore.get(runId);
  expect(afterNewActive?.activeParticipantId).toBe("part_new_active");

  const rawRow4 = getDatabase()
    .prepare("SELECT active_participant_id, final_summary, completed_at FROM role_based_runs WHERE id = ?")
    .get(runId) as any;
  expect(rawRow4.active_participant_id).toBe("part_new_active");
  expect(rawRow4.final_summary).toBeNull();
  expect(rawRow4.completed_at).toBeNull();
});

test("RoleBasedRunStore.update enforces terminal state immutability in SQLite", () => {
  const runStore = new RoleBasedRunStore();
  const runId = "run_terminal_immutable_test";

  runStore.create({
    id: runId,
    sessionId: "ses_store_test",
    objective: "Test terminal immutability in SQLite",
    status: "running",
    round: 0,
    budget: defaultBudget,
    policy: defaultPolicy,
    participantIds: [],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
  });

  // Transition running -> completed (terminal)
  runStore.update(runId, {
    status: "completed",
    completedAt: "2026-09-17T00:01:00Z",
    finalSummary: "Done",
  });

  const completed = runStore.get(runId);
  expect(completed?.status).toBe("completed");

  // Attempting to transition from completed -> cancelled must throw invalid_state_transition
  expect(() => {
    runStore.update(runId, { status: "cancelled" });
  }).toThrow(BridgeError);

  try {
    runStore.update(runId, { status: "cancelled" });
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("invalid_state_transition");
  }

  // Attempting to transition from completed -> failed must throw invalid_state_transition
  expect(() => {
    runStore.update(runId, { status: "failed" });
  }).toThrow(BridgeError);

  // Updating lifecycle fields on a terminal run with new values must throw invalid_state_transition
  expect(() => {
    runStore.update(runId, { finalSummary: "Amended summary" });
  }).toThrow(BridgeError);

  // Re-asserting identical values is idempotent and allowed
  runStore.update(runId, { status: "completed", finalSummary: "Done" });
  expect(runStore.get(runId)?.status).toBe("completed");
  expect(runStore.get(runId)?.finalSummary).toBe("Done");
});

test("RoleBasedRunStore.update enforces immutability across all terminal statuses in SQLite", () => {
  const runStore = new RoleBasedRunStore();

  for (const termStatus of ROLE_BASED_TERMINAL_STATUSES) {
    const runId = `run_term_sql_${termStatus}`;
    runStore.create({
      id: runId,
      sessionId: "ses_store_test",
      objective: "Test SQLite terminal immutability",
      status: "running",
      round: 0,
      budget: { maxTurns: 10, maxParticipants: 3, maxParallelTurns: 1, maxRetriesPerParticipant: 2, maxWallClockMs: 60000 },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      participantIds: ["part_1"],
      participantsById: {},
      turnHistory: [],
      createdAt: "2026-09-17T00:00:00Z",
    });

    const settledCompletedAt = "2026-09-17T01:00:00Z";
    const settledSummary = `Settled as ${termStatus}`;

    // Transition to terminal status
    runStore.update(runId, {
      status: termStatus,
      round: 1,
      finalSummary: settledSummary,
      completedAt: settledCompletedAt,
      activeParticipantId: null,
    });

    const terminal = runStore.get(runId);
    expect(terminal?.status).toBe(termStatus);
    expect(terminal?.round).toBe(1);
    expect(terminal?.finalSummary).toBe(settledSummary);
    expect(terminal?.completedAt).toBe(settledCompletedAt);
    expect(terminal?.activeParticipantId).toBeUndefined();

    // 1. Modifying status fails
    expect(() => {
      runStore.update(runId, { status: "running" });
    }).toThrow(BridgeError);

    // 2. Modifying round fails
    expect(() => {
      runStore.update(runId, { round: 5 });
    }).toThrow(BridgeError);

    // 3. Modifying activeParticipantId fails
    expect(() => {
      runStore.update(runId, { activeParticipantId: "part_1" });
    }).toThrow(BridgeError);

    // 4. Modifying finalSummary fails
    expect(() => {
      runStore.update(runId, { finalSummary: "Illegal alteration" });
    }).toThrow(BridgeError);

    // 5. Modifying completedAt fails
    expect(() => {
      runStore.update(runId, { completedAt: "2026-09-17T02:00:00Z" });
    }).toThrow(BridgeError);

    // Idempotent exact-value patch succeeds
    runStore.update(runId, {
      status: termStatus,
      round: 1,
      finalSummary: settledSummary,
      completedAt: settledCompletedAt,
      activeParticipantId: null,
    });

    const reloaded = runStore.get(runId);
    expect(reloaded?.status).toBe(termStatus);
    expect(reloaded?.round).toBe(1);
    expect(reloaded?.finalSummary).toBe(settledSummary);
    expect(reloaded?.completedAt).toBe(settledCompletedAt);
  }
});


