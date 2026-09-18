// ============================================================
// P4.6.1 — Daemon Recovery & Safe Resume Hardening Tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RunController, deriveRoleExecutionCursor } from "./run-controller";
import { InMemoryRoleBasedRunPersistence } from "./collaboration-persistence";
import { SqliteCollaborationPersistence } from "../persistence/sqlite-collaboration-persistence";
import { initDatabase, closeDatabase } from "../persistence/database";
import type {
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
  ParticipantRecord,
} from "./collaboration-domain";
import { requireValidStartedAt } from "./collaboration-domain";
import type { PersistedParticipant } from "./collaboration-persistence";
import type { CollaborationMessageRecord } from "./collaboration-transcript";
import { computeCollaborationMessageHash } from "./collaboration-transcript";
import type { RunStore } from "../persistence/run-store";
import type { SessionManager } from "./session-manager";
import type { AuditStore } from "../persistence/audit-store";
import type { ExternalAgentAdapter } from "./domain";
import { BridgeError } from "./errors";
import { restorePersistedParticipants } from "../agents/participant-factory";
import { createBridgeRuntime } from "../runtime/bridge-runtime";
import { ChatGPTWebConversationProvider } from "../providers/chatgpt-web/provider";

// ============================================================
// Stubs and Helpers
// ============================================================

function makeRunStore(): RunStore {
  return { get: () => null, list: () => [], create: () => {}, update: () => {} } as unknown as RunStore;
}
function makeAuditStore(): AuditStore {
  return { log: () => {}, list: () => [] } as unknown as AuditStore;
}
function makeSessionManager(status?: string): SessionManager {
  return {
    get: async () => ({ status: status ?? "active", id: "ses_test" }),
    create: async () => ({ status: "active", id: "ses_test" }),
    shutdown: async () => {},
    recoverInterruptedTurns: () => 0,
    list: () => [],
  } as unknown as SessionManager;
}
function makeAdapter(decision?: any): ExternalAgentAdapter {
  return {
    initialize: async () => {},
    next: async () => decision ?? ({ type: "done", summary: "complete" } as any),
    close: async () => {},
  } as unknown as ExternalAgentAdapter;
}


const ROLE_DEF = {
  id: "architect" as const,
  name: "Architect",
  description: "Architect role",
  systemInstructions: "You are an architect.",
  inputContract: {} as any,
  outputContract: {} as any,
};
const PART_CONFIG = {
  adapterId: "subprocess-jsonl" as const,
  adapterType: "subprocess-jsonl",
  command: ["echo", "hi"],
  cwd: "/tmp",
};

const NOW_ISO = "2026-09-18T00:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function makeRun(overrides?: Partial<RoleBasedCollaborationRun>): RoleBasedCollaborationRun {
  return {
    id: "run_test",
    sessionId: "ses_test",
    objective: "obj",
    status: "running",
    policy: { roleSequence: ["architect"], terminalRoles: ["architect"], loopMode: "once" },
    budget: { maxTurns: 10, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
    participantIds: ["part_01"],
    participantsById: {
      part_01: {
        id: "part_01",
        roleId: "architect",
        adapterId: "subprocess-jsonl",
        status: "idle",
        turnsExecuted: 0,
        consecutiveFailures: 0,
        createdAt: NOW_ISO,
        lastActiveAt: NOW_ISO,
      },
    },
    round: 0,
    turnHistory: [],
    createdAt: NOW_ISO,
    startedAt: NOW_ISO,
    ...overrides,
  };
}

function makePersisted(overrides?: Partial<PersistedParticipant>): PersistedParticipant {
  return {
    id: "part_01",
    runId: "run_test",
    roleId: "architect",
    adapterId: "subprocess-jsonl",
    roleSnapshot: ROLE_DEF,
    configSnapshot: PART_CONFIG,
    status: "idle",
    turnsExecuted: 0,
    consecutiveFailures: 0,
    sequenceIndex: 0,
    createdAt: NOW_ISO,
    lastActiveAt: NOW_ISO,
    ...overrides,
  };
}

function makeCompletedTurn(overrides?: Partial<CollaborationTurnRecord>): CollaborationTurnRecord {
  return {
    id: "cturn_01",
    runId: "run_test",
    round: 0,
    turnIndex: 0,
    participantId: "part_01",
    roleId: "architect",
    status: "completed",
    inputSummary: "Turn",
    decision: { type: "message", content: "Architecture complete" },
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    durationMs: 50,
    ...overrides,
  };
}

function makeDaemonRestartedTurn(overrides?: Partial<CollaborationTurnRecord>): CollaborationTurnRecord {
  return {
    id: "cturn_dr",
    runId: "run_test",
    round: 0,
    turnIndex: 0,
    participantId: "part_01",
    roleId: "architect",
    status: "failed",
    inputSummary: "Turn interrupted by daemon restart",
    error: { code: "daemon_restarted", message: "Crashed", retryable: true },
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<CollaborationMessageRecord> & { content?: string }): CollaborationMessageRecord {
  const content = overrides?.content ?? "Architecture complete";
  const runId = overrides?.runId ?? "run_test";
  const turnId = overrides?.turnId ?? "cturn_01";
  const participantId = overrides?.senderParticipantId ?? "part_01";
  const roleId = overrides?.senderRoleId ?? "architect";
  const decisionType = (overrides?.decisionType ?? "message") as any;
  const contentHash = computeCollaborationMessageHash({ runId, turnId, participantId, roleId, decisionType, content });
  return {
    id: "cmsg_01",
    runId,
    turnId,
    sequenceIndex: 0,
    senderParticipantId: participantId,
    senderRoleId: roleId,
    decisionType,
    content,
    contentHash,
    createdAt: NOW_ISO,
    ...overrides,
  };
}

const PLAN = {
  participantId: "part_01",
  roleId: "architect",
  role: ROLE_DEF,
  adapterId: "subprocess-jsonl",
  config: PART_CONFIG,
  sequenceIndex: 0,
};

function makeCtrl(p?: InMemoryRoleBasedRunPersistence, restore?: any) {
  return new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p, restore);
}

// ============================================================
// Section 1: Timestamp & startedAt Validation (Items 11, 12)
// ============================================================

describe("requireValidStartedAt", () => {
  it("missing startedAt throws persistence_corruption", () => {
    expect(() => requireValidStartedAt(makeRun({ startedAt: undefined }))).toThrow("missing required startedAt");
  });

  it("invalid startedAt string throws persistence_corruption", () => {
    expect(() => requireValidStartedAt(makeRun({ startedAt: "not-a-date" }))).toThrow("invalid startedAt timestamp");
  });

  it("future startedAt beyond acceptable clock skew throws persistence_corruption", () => {
    const future = new Date(NOW_MS + 120_000).toISOString();
    expect(() => requireValidStartedAt(makeRun({ startedAt: future }), NOW_MS)).toThrow("future beyond acceptable clock skew");
  });

  it("valid startedAt parses to finite timestamp", () => {
    const ts = requireValidStartedAt(makeRun({ startedAt: NOW_ISO }), NOW_MS);
    expect(ts).toBe(NOW_MS);
  });
});

// ============================================================
// Section 2: recoverRoleBasedRuns (Items 3-10, 13-15, 38, 39)
// ============================================================

describe("recoverRoleBasedRuns", () => {
  it("returns zero report when rolePersistence is unset", () => {
    const r = makeCtrl().recoverRoleBasedRuns();
    expect(r.examined).toBe(0);
    expect(r.pausedAtSafeBoundary).toBe(0);
    expect(r.syntheticTurnRecorded).toBe(0);
    expect(r.failedRunIds).toHaveLength(0);
  });

  it("Case A: running + activeParticipantId=null + healthy budgets → paused, no synthetic turn", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);
    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    expect(r.examined).toBe(1);
    expect(r.pausedAtSafeBoundary).toBe(1);
    expect(r.syntheticTurnRecorded).toBe(0);
    expect(p.getRun("run_test")!.status).toBe("paused");
    expect(p.getTurns("run_test")).toHaveLength(0);
  });

  it("Case A: safe boundary + expired wall clock → timed_out (Item 9)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    const startedAt = NOW_ISO;
    p.createInitialRun(
      makeRun({
        activeParticipantId: undefined,
        startedAt,
        budget: { maxTurns: 10, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 1000 },
      }),
      [PLAN],
    );
    // Recover at NOW_MS + 1001ms
    const r = makeCtrl(p).recoverRoleBasedRuns({
      now: () => NOW_MS + 1001,
      clock: () => new Date(NOW_MS + 1001).toISOString(),
    });

    expect(r.budgetExhaustedAtRecovery).toBe(1);
    const recovered = p.getRun("run_test")!;
    expect(recovered.status).toBe("timed_out");
    expect(recovered.completedAt).not.toBeNull();
    expect(recovered.activeParticipantId).toBeUndefined();
    expect(p.getTurns("run_test")).toHaveLength(0);
  });

  it("Case A: safe boundary + maxTurns consumed → budget_exhausted (Item 10)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(
      makeRun({
        activeParticipantId: undefined,
        budget: { maxTurns: 1, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
      }),
      [PLAN],
    );
    // Add 1 canonical turn so existingTurns.length (1) >= maxTurns (1)
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ turnIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "running", activeParticipantId: null },
    });

    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("budget_exhausted");
  });

  it("Case A: safe boundary with active participant in participantsById throws role_run_recovery_failed (Item 13)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    const run = makeRun({
      activeParticipantId: undefined,
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    p.createInitialRun(run, [PLAN]);

    expect(() => makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }))
      .toThrow("has status 'active'");
  });

  it("Case B: active crash creates synthetic daemon_restarted turn, participant consecutiveFailures++, run paused", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01" }), [PLAN]);
    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    expect(r.syntheticTurnRecorded).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("paused");
    expect(p.getRun("run_test")!.activeParticipantId).toBeUndefined();

    const turns = p.getTurns("run_test");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.error?.code).toBe("daemon_restarted");
    expect(turns[0]!.error?.retryable).toBe(true);
    expect(turns[0]!.status).toBe("failed");
    expect(p.getParticipants("run_test")[0]!.consecutiveFailures).toBe(1);
  });

  it("Case B: active crash uses participant.lastActiveAt for startedAt (Item 38)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    const lastActiveAt = new Date(NOW_MS - 5000).toISOString();
    const run = makeRun({
      activeParticipantId: "part_01",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO, lastActiveAt },
      },
    });
    p.createInitialRun(run, [PLAN]);
    makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    const turns = p.getTurns("run_test");
    expect(turns[0]!.startedAt).toBe(lastActiveAt);
    expect(turns[0]!.completedAt).toBe(NOW_ISO);
    expect(turns[0]!.durationMs).toBeUndefined();
  });

  it("Case B: active crash never emits canonical collaboration_messages (Item 39)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01" }), [PLAN]);
    makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    expect(p.getTranscript("run_test")).toHaveLength(0);
  });

  it("Case B: activeParticipantId references missing participant throws role_run_recovery_failed (Item 13)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_ghost" }), [PLAN]);
    expect(() => makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }))
      .toThrow("references activeParticipantId 'part_ghost' which does not exist");
  });

  it("Case B: maxTurns=1 + first active turn crashes → budget_exhausted (Item 5)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        budget: { maxTurns: 1, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
      }),
      [PLAN],
    );
    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("budget_exhausted");
  });

  it("Case B: 2 persisted turns + 3rd active attempt crashes with maxTurns=3 → budget_exhausted (Item 6)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        budget: { maxTurns: 3, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
      }),
      [PLAN],
    );
    // Add turn 0 and turn 1
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ id: "t0", turnIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "running" },
    });
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ id: "t1", turnIndex: 1 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 2, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "running", activeParticipantId: "part_01" },
    });

    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("budget_exhausted");
    expect(p.getTurns("run_test")).toHaveLength(3);
  });

  it("Case B: active participant with turnsBeforeSynthetic >= maxTurns throws role_run_recovery_failed (Item 4)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        budget: { maxTurns: 1, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
      }),
      [PLAN],
    );
    // Already has 1 turn persisted, but activeParticipantId is also set
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ id: "t0", turnIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "running", activeParticipantId: "part_01" },
    });

    expect(() => makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }))
      .toThrow("already reached or exceeded maxTurns");
  });

  it("is idempotent: second call sees 0 running runs", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);
    const ctrl = makeCtrl(p);
    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }).examined).toBe(0);
  });

  it("does not touch terminal runs (completed, failed)", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun(), [PLAN]);
    p.finalizeRun("run_test", { status: "completed", completedAt: NOW_ISO });
    expect(makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }).examined).toBe(0);
  });
});

// ============================================================
// Section 3: deriveRoleExecutionCursor Hardening (Items 20-32)
// ============================================================

describe("deriveRoleExecutionCursor validation", () => {
  it("fresh run (no turns) → cursor at start", () => {
    const c = deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [], []);
    expect(c.round).toBe(0);
    expect(c.sequenceIndex).toBe(0);
    expect(c.nextTurnIndex).toBe(0);
    expect(c.nextMessageSequenceIndex).toBe(0);
    expect(c.interruptedTurnReplayRequired).toBe(false);
  });

  it("after one completed turn (2-role sequence) → seqIdx advances", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
      participantIds: ["part_01", "part_02"],
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
        part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const parts = [
      makePersisted({ id: "part_01", roleId: "architect", sequenceIndex: 0, turnsExecuted: 1 }),
      makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1, turnsExecuted: 0 }),
    ];
    const turns = [makeCompletedTurn({ turnIndex: 0, participantId: "part_01", roleId: "architect" })];
    const msgs = [makeMessage({ turnId: "cturn_01", sequenceIndex: 0 })];

    const c = deriveRoleExecutionCursor(run, parts, turns, msgs);
    expect(c.sequenceIndex).toBe(1);
    expect(c.round).toBe(0);
  });

  it("daemon_restarted turn → interruptedTurnReplayRequired=true, seqIdx unchanged", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 1, createdAt: NOW_ISO },
      },
    });
    const parts = [makePersisted({ consecutiveFailures: 1 })];
    const turns = [makeDaemonRestartedTurn()];

    const c = deriveRoleExecutionCursor(run, parts, turns, []);
    expect(c.interruptedTurnReplayRequired).toBe(true);
    expect(c.interruptedParticipantId).toBe("part_01");
    expect(c.sequenceIndex).toBe(0);
  });

  it("daemon_restarted cleared by subsequent successful turn", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
      participantIds: ["part_01", "part_02"],
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
        part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const parts = [
      makePersisted({ id: "part_01", roleId: "architect", sequenceIndex: 0, turnsExecuted: 1, consecutiveFailures: 0 }),
      makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1, turnsExecuted: 0, consecutiveFailures: 0 }),
    ];
    const turns = [
      makeDaemonRestartedTurn({ id: "t0", turnIndex: 0, participantId: "part_01", roleId: "architect" }),
      makeCompletedTurn({ id: "t1", turnIndex: 1, participantId: "part_01", roleId: "architect" }),
    ];
    const msgs = [makeMessage({ turnId: "t1", sequenceIndex: 0 })];

    const c = deriveRoleExecutionCursor(run, parts, turns, msgs);
    expect(c.interruptedTurnReplayRequired).toBe(false);
    expect(c.sequenceIndex).toBe(1);
  });

  it("paused run with activeParticipantId throws persistence_corruption (Item 30)", () => {
    const run = makeRun({ status: "paused", activeParticipantId: "part_01" });
    expect(() => deriveRoleExecutionCursor(run, [makePersisted()], [], []))
      .toThrow("activeParticipantId is set");
  });

  it("paused run with active participant status throws persistence_corruption (Item 30)", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const parts = [makePersisted({ status: "active" })];
    expect(() => deriveRoleExecutionCursor(run, parts, [], []))
      .toThrow("has status 'active'");
  });

  it("participant count mismatch throws persistence_corruption (Item 21)", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
      participantIds: ["part_01"], // mismatch: 1 vs 2
    });
    expect(() => deriveRoleExecutionCursor(run, [makePersisted()], [], []))
      .toThrow("participant count mismatch");
  });

  it("duplicate participant IDs throws persistence_corruption (Item 21)", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
      participantIds: ["part_01", "part_01"],
    });
    const parts = [
      makePersisted({ id: "part_01", sequenceIndex: 0 }),
      makePersisted({ id: "part_01", sequenceIndex: 1 }),
    ];
    expect(() => deriveRoleExecutionCursor(run, parts, [], []))
      .toThrow("duplicate participant IDs");
  });

  it("participant role mismatch throws persistence_corruption (Item 21)", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect"], terminalRoles: ["architect"], loopMode: "once" },
    });
    const parts = [makePersisted({ roleId: "implementer" })]; // expected architect
    expect(() => deriveRoleExecutionCursor(run, parts, [], []))
      .toThrow("role mismatch");
  });

  it("turn provenance mismatch throws persistence_corruption (Item 22)", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
      participantIds: ["part_01", "part_02"],
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
        part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const parts = [
      makePersisted({ id: "part_01", roleId: "architect", sequenceIndex: 0 }),
      makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1, turnsExecuted: 1 }),
    ];
    // Expected architect first, but turn says implementer
    const turns = [makeCompletedTurn({ turnIndex: 0, participantId: "part_02", roleId: "implementer" })];
    const msgs = [makeMessage({ turnId: "cturn_01", senderParticipantId: "part_02", senderRoleId: "implementer" })];

    expect(() => deriveRoleExecutionCursor(run, parts, turns, msgs))
      .toThrow("does not match expected participant");
  });

  it("round mismatch throws persistence_corruption (Item 23)", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const parts = [makePersisted({ turnsExecuted: 1 })];
    // Turn claims round 7 when derived round is 0
    const turns = [makeCompletedTurn({ turnIndex: 0, round: 7 })];
    const msgs = [makeMessage({ turnId: "cturn_01" })];

    expect(() => deriveRoleExecutionCursor(run, parts, turns, msgs))
      .toThrow("round 7 does not match derived round 0");
  });

  it("message references nonexistent turn throws persistence_corruption (Item 25)", () => {
    const msg = makeMessage({ turnId: "ghost_turn" });
    expect(() => deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [], [msg]))
      .toThrow("references nonexistent turn");
  });

  it("operational failure has canonical message throws persistence_corruption (Item 27)", () => {
    const turn = makeDaemonRestartedTurn();
    const msg = makeMessage({ turnId: turn.id });
    expect(() => deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [turn], [msg]))
      .toThrow("operational failure or cancelled turn and must not produce a canonical message");
  });

  it("canonical content vs decision mismatch throws persistence_corruption (Item 26)", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    const turn = makeCompletedTurn({ decision: { type: "message", content: "Original content" } });
    const msg = makeMessage({ turnId: turn.id, content: "Tampered content" });

    expect(() => deriveRoleExecutionCursor(run, [makePersisted({ turnsExecuted: 1 })], [turn], [msg]))
      .toThrow("content does not match turn decision text");
  });

  it("turnsExecuted mismatch throws persistence_corruption (Item 28)", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 5, consecutiveFailures: 0, createdAt: NOW_ISO },
      },
    });
    // claims turnsExecuted=5 but only 0 turns exist
    expect(() => deriveRoleExecutionCursor(run, [makePersisted({ turnsExecuted: 5 })], [], []))
      .toThrow("persisted turnsExecuted (5) does not match canonical completed turns (0)");
  });

  it("consecutiveFailures mismatch throws persistence_corruption (Item 29)", () => {
    const run = makeRun({
      status: "paused",
      participantsById: {
        part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 4, createdAt: NOW_ISO },
      },
    });
    // claims consecutiveFailures=4 but 0 failed turns exist
    expect(() => deriveRoleExecutionCursor(run, [makePersisted({ consecutiveFailures: 4 })], [], []))
      .toThrow("persisted consecutiveFailures (4) does not match derived trailing failures (0)");
  });
});

// ============================================================
// Section 4: Safe Explicit Resume Validation & Budgets (Items 33-37)
// ============================================================

describe("resumeRoleBasedRun validation & budget terminalization", () => {
  it("rejects when run not found", async () => {
    await expect(makeCtrl(new InMemoryRoleBasedRunPersistence()).resumeRoleBasedRun("run_x"))
      .rejects.toThrow("not found");
  });

  it("rejects when run is running (invalid_state_transition)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ status: "running" }), [PLAN]);
    await expect(makeCtrl(p).resumeRoleBasedRun("run_test")).rejects.toThrow("must be 'paused'");
  });

  it("rejects when run is completed (invalid_state_transition)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun(), [PLAN]);
    p.finalizeRun("run_test", { status: "completed", completedAt: NOW_ISO });
    await expect(makeCtrl(p).resumeRoleBasedRun("run_test")).rejects.toThrow("must be 'paused'");
  });

  it("requires replay confirmation when last turn was daemon_restarted", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01" }), [PLAN]);
    const ctrl = makeCtrl(p);
    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    expect(p.getRun("run_test")!.status).toBe("paused");
    await expect(ctrl.resumeRoleBasedRun("run_test")).rejects.toThrow("allowReplayInterruptedTurn=true");
  });

  it("rejects concurrent double-resume (resume_in_progress)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);

    let resolveAdapter!: (v: any) => void;
    const stalledAdapter: ExternalAgentAdapter = {
      initialize: async () => {},
      next: () => new Promise((r) => { resolveAdapter = r; }),
      close: async () => { resolveAdapter?.({ type: "done", summary: "closed" }); },
    } as any;


    const ctrl = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p,
      (_participants) => ({
        plans: [PLAN],
        runtimes: [{ participantId: "part_01", roleId: "architect", adapter: stalledAdapter }],
        records: { participantIds: ["part_01"], participantsById: { part_01: makeRun().participantsById["part_01"]! } },
      } as any),
    );
    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO }); // pauses run

    const r1 = ctrl.resumeRoleBasedRun("run_test", { now: () => NOW_MS, clock: () => NOW_ISO });
    await expect(ctrl.resumeRoleBasedRun("run_test", { now: () => NOW_MS, clock: () => NOW_ISO }))
      .rejects.toThrow("already being resumed");

    resolveAdapter?.({ type: "done", summary: "done" });
    await r1.catch(() => {});
  });

  it("resume after elapsed wall-clock → persists timed_out, adapter factory calls = 0 (Items 34, 37)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    let adapterFactoryCalls = 0;
    p.createInitialRun(
      makeRun({
        startedAt: NOW_ISO,
        budget: { maxTurns: 10, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 1000 },
      }),
      [PLAN],
    );
    p.finalizeRun("run_test", { status: "paused", activeParticipantId: null });

    const ctrl = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p,
      (_parts) => {
        adapterFactoryCalls++;
        return { plans: [], runtimes: [], records: { participantIds: [], participantsById: {} } } as any;
      },
    );

    await expect(
      ctrl.resumeRoleBasedRun("run_test", {
        now: () => NOW_MS + 2000,
        clock: () => new Date(NOW_MS + 2000).toISOString(),
      }),
    ).rejects.toThrow("wall-clock budget exhausted");

    expect(adapterFactoryCalls).toBe(0);
    const persisted = p.getRun("run_test")!;
    expect(persisted.status).toBe("timed_out");
    expect(persisted.completedAt).not.toBeNull();
  });

  it("resume after exhausted maxTurns → persists budget_exhausted, adapter factory calls = 0 (Items 35, 37)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    let adapterFactoryCalls = 0;
    p.createInitialRun(
      makeRun({
        startedAt: NOW_ISO,
        policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
        participantIds: ["part_01", "part_02"],
        budget: { maxTurns: 1, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
        participantsById: {
          part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
          part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
        },
      }),
      [
        PLAN,
        { participantId: "part_02", roleId: "implementer", role: { ...ROLE_DEF, id: "implementer" as any, name: "Impl" }, adapterId: "subprocess-jsonl", config: PART_CONFIG, sequenceIndex: 1 },
      ],
    );
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ turnIndex: 0 }),
      message: makeMessage({ turnId: "cturn_01", sequenceIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "paused", activeParticipantId: null },
    });

    const ctrl = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p,
      (_parts) => {
        adapterFactoryCalls++;
        return { plans: [], runtimes: [], records: { participantIds: [], participantsById: {} } } as any;
      },
    );

    await expect(
      ctrl.resumeRoleBasedRun("run_test", { now: () => NOW_MS, clock: () => NOW_ISO }),
    ).rejects.toThrow("turn budget exhausted");

    expect(adapterFactoryCalls).toBe(0);
    const persisted = p.getRun("run_test")!;
    expect(persisted.status).toBe("budget_exhausted");
  });


  it("loopMode=once already-complete cursor → finalizes completed without adapter calls (Item 32)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    let adapterFactoryCalls = 0;
    p.createInitialRun(
      makeRun({
        startedAt: NOW_ISO,
        policy: { roleSequence: ["architect"], terminalRoles: ["architect"], loopMode: "once" },
        participantsById: {
          part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
        },
      }),
      [PLAN],
    );
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ turnIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "paused", activeParticipantId: null },
    });

    const ctrl = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p,
      (_parts) => {
        adapterFactoryCalls++;
        return { plans: [], runtimes: [], records: { participantIds: [], participantsById: {} } } as any;
      },
    );

    const completed = await ctrl.resumeRoleBasedRun("run_test", { now: () => NOW_MS, clock: () => NOW_ISO });
    expect(completed.status).toBe("completed");
    expect(adapterFactoryCalls).toBe(0);
    expect(p.getRun("run_test")!.status).toBe("completed");
  });

  it("resumed waitForRoleBasedRun result equals canonical persistence (Item 50)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01", startedAt: NOW_ISO }), [PLAN]);

    const doneAdapter: ExternalAgentAdapter = {
      initialize: async () => {},
      next: async () => ({ type: "done", summary: "resumed and done" } as any),
      close: async () => {},
    } as any;


    const ctrl = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p,
      (_participants) => ({
        plans: [PLAN],
        runtimes: [{ participantId: "part_01", roleId: "architect", adapter: doneAdapter, recreateAdapter: undefined }],
        records: { participantIds: ["part_01"], participantsById: { part_01: makeRun().participantsById["part_01"]! } },
      } as any),
    );

    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(p.getRun("run_test")!.status).toBe("paused");

    await ctrl.resumeRoleBasedRun("run_test", { allowReplayInterruptedTurn: true, now: () => NOW_MS, clock: () => NOW_ISO });
    const activeResult = await ctrl.waitForRoleBasedRun("run_test");

    const persistedRun = p.getRun("run_test")!;
    const persistedTurns = p.getTurns("run_test");

    expect(activeResult.run.id).toBe(persistedRun.id);
    expect(activeResult.run.status).toBe(persistedRun.status);
    expect(activeResult.run.round).toBe(persistedRun.round);
    expect(activeResult.run.turnHistory).toEqual(persistedRun.turnHistory);
    expect(activeResult.run.finalSummary).toBe(persistedRun.finalSummary);
    expect(activeResult.run.completedAt).toBe(persistedRun.completedAt);
    expect(activeResult.turns.map((t) => t.id)).toEqual(persistedTurns.map((t) => t.id));
  });
});

// ============================================================
// Section 5: Real SQLite Restart Tests (Items 40-44)
// ============================================================

describe("Real SQLite Daemon Restart & Resumption", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-sqlite-restart-"));
    dbPath = path.join(tempDir, "bridge_test.db");
  });

  function safeRmDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows file locking fallback
    }
  }

  afterEach(() => {
    closeDatabase();
    safeRmDir(tempDir);
  });


  it("Real SQLite safe-boundary restart (Item 41)", () => {
    // Daemon #1: create session, run, persist healthy running state at safe boundary
    const db1 = initDatabase(dbPath);
    db1.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_sq_1', 'chatgpt-web', 'gpt-4', 'active', '${NOW_ISO}', '${NOW_ISO}');
    `);
    const p1 = new SqliteCollaborationPersistence();
    p1.createInitialRun(
      makeRun({ id: "run_sq_1", sessionId: "ses_sq_1", activeParticipantId: undefined, startedAt: NOW_ISO }),
      [PLAN],
    );
    closeDatabase();

    // Daemon #2: reopen same file, recover
    initDatabase(dbPath);
    const p2 = new SqliteCollaborationPersistence();
    const ctrl2 = new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p2);

    const report = ctrl2.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(report.examined).toBe(1);
    expect(report.pausedAtSafeBoundary).toBe(1);
    expect(report.syntheticTurnRecorded).toBe(0);

    const recovered = p2.getRun("run_sq_1")!;
    expect(recovered.status).toBe("paused");
    expect(recovered.activeParticipantId).toBeUndefined();
    expect(recovered.completedAt).toBeUndefined();
    expect(p2.getTurns("run_sq_1")).toHaveLength(0);
  });

  it("Real SQLite active-turn restart creates daemon_restarted turn, no message (Item 42)", () => {
    // Daemon #1: run was mid-turn with activeParticipantId='part_01'
    const db1 = initDatabase(dbPath);
    db1.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_sq_2', 'chatgpt-web', 'gpt-4', 'active', '${NOW_ISO}', '${NOW_ISO}');
    `);
    const p1 = new SqliteCollaborationPersistence();
    p1.createInitialRun(
      makeRun({ id: "run_sq_2", sessionId: "ses_sq_2", activeParticipantId: "part_01", startedAt: NOW_ISO }),
      [PLAN],
    );
    closeDatabase();

    // Daemon #2: reopen same file, recover
    initDatabase(dbPath);
    const p2 = new SqliteCollaborationPersistence();
    const ctrl2 = new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p2);

    const report = ctrl2.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    expect(report.examined).toBe(1);
    expect(report.syntheticTurnRecorded).toBe(1);

    const recovered = p2.getRun("run_sq_2")!;
    expect(recovered.status).toBe("paused");
    expect(recovered.activeParticipantId).toBeUndefined();

    const turns = p2.getTurns("run_sq_2");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.error?.code).toBe("daemon_restarted");
    expect(turns[0]!.status).toBe("failed");

    // Synthetic turn must NEVER emit canonical messages (Item 39)
    const transcript = p2.getTranscript("run_sq_2");
    expect(transcript).toHaveLength(0);
  });

  it("Real SQLite recovery idempotency (Item 43)", () => {
    const db1 = initDatabase(dbPath);
    db1.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_sq_3', 'chatgpt-web', 'gpt-4', 'active', '${NOW_ISO}', '${NOW_ISO}');
    `);
    const p1 = new SqliteCollaborationPersistence();
    p1.createInitialRun(
      makeRun({ id: "run_sq_3", sessionId: "ses_sq_3", activeParticipantId: "part_01", startedAt: NOW_ISO }),
      [PLAN],
    );
    closeDatabase();

    // Recover once
    initDatabase(dbPath);
    const p2 = new SqliteCollaborationPersistence();
    const ctrl2 = new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p2);
    ctrl2.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });
    closeDatabase();

    // Recover second time on reopen
    initDatabase(dbPath);
    const p3 = new SqliteCollaborationPersistence();
    const ctrl3 = new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p3);
    const r2 = ctrl3.recoverRoleBasedRuns({ now: () => NOW_MS, clock: () => NOW_ISO });

    expect(r2.examined).toBe(0);
    expect(p3.getTurns("run_sq_3")).toHaveLength(1); // Still exactly 1 synthetic turn
  });

  it("Real SQLite resume append durability (Item 44)", async () => {
    // Daemon #1: persist paused run with 1 completed turn
    const db1 = initDatabase(dbPath);
    db1.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_sq_4', 'chatgpt-web', 'gpt-4', 'active', '${NOW_ISO}', '${NOW_ISO}');
    `);
    const p1 = new SqliteCollaborationPersistence();
    p1.createInitialRun(
      makeRun({
        id: "run_sq_4",
        sessionId: "ses_sq_4",
        policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
        participantIds: ["part_01", "part_02"],
        participantsById: {
          part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
          part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
        },
        startedAt: NOW_ISO,
      }),
      [
        PLAN,
        { participantId: "part_02", roleId: "implementer", role: { ...ROLE_DEF, id: "implementer" as any, name: "Impl" }, adapterId: "subprocess-jsonl", config: PART_CONFIG, sequenceIndex: 1 },
      ],
    );
    p1.recordTurnTransaction({
      turn: makeCompletedTurn({ id: "t0", runId: "run_sq_4", turnIndex: 0 }),
      message: makeMessage({ id: "m0", runId: "run_sq_4", turnId: "t0", sequenceIndex: 0, content: "Architecture complete" }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_sq_4", status: "paused", activeParticipantId: null },
    });
    closeDatabase();

    // Daemon #2: reopen, resume and execute turn 1
    initDatabase(dbPath);
    const p2 = new SqliteCollaborationPersistence();

    const doneAdapter: ExternalAgentAdapter = {
      initialize: async () => {},
      next: async () => ({ type: "done", summary: "implementation complete" } as any),
      close: async () => {},
    } as any;


    const ctrl2 = new RunController(
      makeRunStore(),
      makeSessionManager(),
      makeAuditStore(),
      (_id) => makeAdapter(),
      p2,
      (parts) => restorePersistedParticipants(parts, { factory: () => doneAdapter }),
    );


    const resumed = await ctrl2.resumeRoleBasedRun("run_sq_4", {
      now: () => NOW_MS,
      clock: () => NOW_ISO,
    });
    expect(resumed.status).toBe("running");
    await ctrl2.waitForRoleBasedRun("run_sq_4");
    closeDatabase();

    // Daemon #3: verify append durability
    initDatabase(dbPath);
    const p3 = new SqliteCollaborationPersistence();
    const finalRun = p3.getRun("run_sq_4")!;
    expect(finalRun.status).toBe("completed");

    const turns = p3.getTurns("run_sq_4");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.id).toBe("t0");
    expect(turns[1]!.participantId).toBe("part_02");

    const transcript = p3.getTranscript("run_sq_4");
    expect(transcript).toHaveLength(2);
  });
});

// ============================================================
// Section 6: Historical Participant Restoration (Items 45-48)
// ============================================================

describe("Historical Participant Restoration without RoleRegistry", () => {
  it("restores original role systemInstructions (ARCHITECT_V1), not ambient registry (Item 45)", () => {
    const historicalRole = {
      id: "architect" as const,
      name: "Architect",
      description: "Original architect",
      systemInstructions: "ARCHITECT_V1",
      inputContract: {} as any,
      outputContract: {} as any,
    };
    const participant = makePersisted({ roleSnapshot: historicalRole });

    const prepared = restorePersistedParticipants([participant]);
    expect(prepared.plans[0]!.role.systemInstructions).toBe("ARCHITECT_V1");
  });

  it("custom historical role survives without registry entry (Item 46)", () => {
    const customRole = {
      id: "security_reviewer" as const,
      name: "Security Reviewer",
      description: "Audits security invariants",
      systemInstructions: "Audit for security bugs",
      inputContract: {} as any,
      outputContract: {} as any,
    };
    const participant = makePersisted({
      roleId: "security_reviewer",
      roleSnapshot: customRole,
    });

    const prepared = restorePersistedParticipants([participant]);
    expect(prepared.plans[0]!.roleId).toBe("security_reviewer");
    expect(prepared.plans[0]!.role.name).toBe("Security Reviewer");
  });

  it("historical permissionMode and config preserved without elevation (Item 47)", () => {
    const config = {
      adapterType: "acp:antigravity",
      config: {
        permissionMode: "deny",
      },
      cwd: "/sandbox/safe",
    };
    const participant = makePersisted({
      adapterId: "acp:antigravity",
      configSnapshot: config,
    });

    const prepared = restorePersistedParticipants([participant], {
      locator: (cmd) => `/opt/antigravity/bin/${cmd}`,
      factory: () => makeAdapter(),
    });
    expect(prepared.plans[0]!.config.config?.permissionMode).toBe("deny");
    expect(prepared.plans[0]!.config.cwd).toBe("/sandbox/safe");
  });


  it("acp:antigravity resolves to agy-acp (never agy --acp) (Item 48)", () => {
    const config = {
      adapterType: "acp:antigravity",
      adapterId: "acp:antigravity",
      cwd: "/tmp",
    };
    const participant = makePersisted({
      adapterId: "acp:antigravity",
      configSnapshot: config,
    });

    const prepared = restorePersistedParticipants([participant], {
      locator: (cmd) => `/opt/antigravity/bin/${cmd}`,
      factory: () => makeAdapter(),
    });
    expect(prepared.plans[0]!.config.adapterType).toBe("acp:antigravity");
  });

});

// ============================================================
// Section 7: Runtime Startup Fail-Closed (Items 17, 18)
// ============================================================

describe("BridgeRuntime Startup Recovery Fail-Closed", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-runtime-fail-"));
    dbPath = path.join(tempDir, "bridge_fail.db");
  });

  function safeRmDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows file locking fallback
    }
  }

  afterEach(() => {
    closeDatabase();
    safeRmDir(tempDir);
  });


  it("corrupt orphaned P4 state causes createBridgeRuntime to reject and clean up database (Item 18)", async () => {
    // Inject corrupt state in SQLite: activeParticipantId points to nonexistent participant
    const db = initDatabase(dbPath);
    db.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_fail_1', 'chatgpt-web', 'gpt-4', 'active', '${NOW_ISO}', '${NOW_ISO}');
    `);
    const p = new SqliteCollaborationPersistence();
    p.createInitialRun(
      makeRun({ id: "run_corrupt_1", sessionId: "ses_fail_1", activeParticipantId: "part_missing", startedAt: NOW_ISO }),
      [PLAN],
    );
    closeDatabase();

    // Now try booting runtime on this DB
    process.env.AGENT_CHATGPT_DB_PATH = dbPath;
    try {
      await expect(
        createBridgeRuntime(
          {} as any,
          {
            provider: new ChatGPTWebConversationProvider({} as any),
            codexRouter: false,
          },
        ),
      ).rejects.toThrow();

    } finally {
      delete process.env.AGENT_CHATGPT_DB_PATH;
    }
  });
});
