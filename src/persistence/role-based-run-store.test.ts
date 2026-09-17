import { expect, test, beforeEach, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "./database";
import { RoleBasedRunStore } from "./role-based-run-store";
import { CollaborationParticipantStore } from "./collaboration-participant-store";
import { CollaborationTurnStore } from "./collaboration-turn-store";
import { CollaborationMessageStore } from "./collaboration-message-store";
import type {
  RoleBasedCollaborationRun,
  RoleBasedRunBudget,
  RunPolicy,
} from "../core/collaboration-domain";
import type { ParticipantAssignmentPlan } from "../core/participant-assignment";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "../core/collaboration-transcript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDbPath = path.join(os.tmpdir(), `test-p4-stores-${Date.now()}.db`);

beforeEach(() => {
  closeDatabase();
  for (const p of [testDbPath, testDbPath + "-wal", testDbPath + "-shm"]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const db = initDatabase(testDbPath);
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES ('ses_store_test', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
  `);
});

afterEach(() => {
  closeDatabase();
  for (const p of [testDbPath, testDbPath + "-wal", testDbPath + "-shm"]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
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
