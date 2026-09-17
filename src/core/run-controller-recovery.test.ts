// ============================================================
// P4.6 — Daemon Recovery & Safe Resume Tests
// ============================================================

import { describe, it, expect } from "bun:test";
import { RunController, deriveRoleExecutionCursor } from "./run-controller";
import { InMemoryRoleBasedRunPersistence } from "./collaboration-persistence";
import type { RoleBasedCollaborationRun, CollaborationTurnRecord } from "./collaboration-domain";
import type { PersistedParticipant } from "./collaboration-persistence";
import type { CollaborationMessageRecord } from "./collaboration-transcript";
import { computeCollaborationMessageHash } from "./collaboration-transcript";
import type { RunStore } from "../persistence/run-store";
import type { SessionManager } from "./session-manager";
import type { AuditStore } from "../persistence/audit-store";
import type { ExternalAgentAdapter } from "./domain";

// ============================================================
// Stubs
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
function makeAdapter(): ExternalAgentAdapter {
  return {
    initialize: async () => {},
    executeAgentTurn: async () => ({ type: "done", summary: "complete" } as any),
    close: async () => {},
  } as unknown as ExternalAgentAdapter;
}

const ROLE_DEF = {
  id: "architect" as const, name: "Architect", description: "Architect role",
  systemInstructions: "You are an architect.", inputContract: {} as any, outputContract: {} as any,
};
const PART_CONFIG = { adapterId: "subprocess-jsonl" as const, adapterType: "subprocess-jsonl", command: ["echo", "hi"], cwd: "/tmp" };
const NOW_ISO = "2026-01-01T00:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function makeRun(overrides?: Partial<RoleBasedCollaborationRun>): RoleBasedCollaborationRun {
  return {
    id: "run_test", sessionId: "ses_test", objective: "obj", status: "running",
    policy: { roleSequence: ["architect"], terminalRoles: ["architect"], loopMode: "once" },
    budget: { maxTurns: 10, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
    participantIds: ["part_01"],
    participantsById: {
      part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
    },
    round: 0, turnHistory: [],
    createdAt: NOW_ISO, startedAt: NOW_ISO,

    ...overrides,
  };
}

function makePersisted(overrides?: Partial<PersistedParticipant>): PersistedParticipant {
  return {
    id: "part_01", runId: "run_test", roleId: "architect", adapterId: "subprocess-jsonl",
    roleSnapshot: ROLE_DEF, configSnapshot: PART_CONFIG,
    status: "idle", turnsExecuted: 0, consecutiveFailures: 0, sequenceIndex: 0, createdAt: NOW_ISO,
    ...overrides,
  };
}

function makeCompletedTurn(overrides?: Partial<CollaborationTurnRecord>): CollaborationTurnRecord {
  return {
    id: "cturn_01", runId: "run_test", round: 0, turnIndex: 0,
    participantId: "part_01", roleId: "architect", status: "completed",
    inputSummary: "Turn", startedAt: NOW_ISO, completedAt: NOW_ISO, durationMs: 50,
    ...overrides,
  };
}

function makeDaemonRestartedTurn(overrides?: Partial<CollaborationTurnRecord>): CollaborationTurnRecord {
  return {
    id: "cturn_dr", runId: "run_test", round: 0, turnIndex: 0,
    participantId: "part_01", roleId: "architect", status: "failed",
    inputSummary: "Turn interrupted",
    error: { code: "daemon_restarted", message: "Crashed", retryable: true },
    startedAt: NOW_ISO, completedAt: NOW_ISO,
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<CollaborationMessageRecord> & { content?: string }): CollaborationMessageRecord {
  const content = overrides?.content ?? "hello";
  const runId = overrides?.runId ?? "run_test";
  const turnId = overrides?.turnId ?? "cturn_01";
  const participantId = overrides?.senderParticipantId ?? "part_01";
  const roleId = overrides?.senderRoleId ?? "architect";
  const decisionType = (overrides?.decisionType ?? "message") as any;
  const contentHash = computeCollaborationMessageHash({ runId, turnId, participantId, roleId, decisionType, content });
  return {
    id: "cmsg_01", runId, turnId, sequenceIndex: 0,
    senderParticipantId: participantId, senderRoleId: roleId,
    decisionType, content, contentHash, createdAt: NOW_ISO,
    ...overrides,
  };
}

const PLAN = { participantId: "part_01", roleId: "architect", role: ROLE_DEF, adapterId: "subprocess-jsonl", config: PART_CONFIG, sequenceIndex: 0 };

function makeCtrl(p?: InMemoryRoleBasedRunPersistence, restore?: any) {
  return new RunController(makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(), p, restore);
}

// ============================================================
// Section 1: recoverRoleBasedRuns
// ============================================================

describe("recoverRoleBasedRuns", () => {
  it("returns zero report with no rolePersistence", () => {
    const r = makeCtrl().recoverRoleBasedRuns();
    expect(r.examined).toBe(0);
    expect(r.pausedAtSafeBoundary).toBe(0);
    expect(r.syntheticTurnRecorded).toBe(0);
    expect(r.failedRunIds).toHaveLength(0);
  });

  it("Case A: running + no activeParticipantId → paused, no synthetic turn", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);
    const ctrl = makeCtrl(p);
    const r = ctrl.recoverRoleBasedRuns({ now: () => NOW_MS });

    expect(r.examined).toBe(1);
    expect(r.pausedAtSafeBoundary).toBe(1);
    expect(r.syntheticTurnRecorded).toBe(0);
    expect(p.getRun("run_test")!.status).toBe("paused");
    expect(p.getTurns("run_test")).toHaveLength(0);
  });

  it("Case B: running + activeParticipantId → synthetic daemon_restarted turn + paused", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01" }), [PLAN]);
    const ctrl = makeCtrl(p);
    const r = ctrl.recoverRoleBasedRuns({ now: () => NOW_MS });

    expect(r.syntheticTurnRecorded).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("paused");
    // activeParticipantId is cleared (may be null or undefined depending on storage)
    expect(p.getRun("run_test")!.activeParticipantId ?? null).toBeNull();


    const turns = p.getTurns("run_test");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.error?.code).toBe("daemon_restarted");
    expect(turns[0]!.error?.retryable).toBe(true);
    expect(turns[0]!.status).toBe("failed");

    // consecutiveFailures incremented
    expect(p.getParticipants("run_test")[0]!.consecutiveFailures).toBe(1);
  });

  it("is idempotent: second call sees 0 running", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);
    const ctrl = makeCtrl(p);
    ctrl.recoverRoleBasedRuns();
    expect(ctrl.recoverRoleBasedRuns().examined).toBe(0);
  });

  it("does not touch terminal runs", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun(), [PLAN]);
    p.finalizeRun("run_test", { status: "completed", completedAt: NOW_ISO });
    expect(makeCtrl(p).recoverRoleBasedRuns().examined).toBe(0);
  });

  it("wall-clock expired at recovery → timed_out", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    // startedAt 2 seconds before NOW_MS, budget 1 second → elapsed 2000 >= 1000
    const startedAt = new Date(NOW_MS - 2000).toISOString();
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        startedAt,
        budget: { maxTurns: 10, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 1000 },
      }),
      [PLAN],
    );
    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("timed_out");
  });

  it("retry budget exhausted at recovery → failed", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    // consecutiveFailures=3, maxRetriesPerParticipant=3 → after +1 = 4 > 3
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        participantsById: {
          part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "active", turnsExecuted: 0, consecutiveFailures: 3, createdAt: NOW_ISO },
        },
      }),
      [PLAN],
    );
    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("failed");
  });

  it("turn budget exhausted at recovery → budget_exhausted", () => {
    const p = new InMemoryRoleBasedRunPersistence();
    // maxTurns=1, no existing turns → syntheticTurnIndex=0 which is NOT >= 1 yet.
    // So we pre-insert a completed turn to make syntheticTurnIndex=1 >= maxTurns=1.
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        budget: { maxTurns: 1, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 60000 },
      }),
      [PLAN],
    );
    // Insert a pre-existing completed turn so the synthetic would be turnIndex=1 >= maxTurns=1
    p.recordTurnTransaction({
      turn: makeCompletedTurn({ id: "t0", turnIndex: 0 }),
      participant: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 1, consecutiveFailures: 0, createdAt: NOW_ISO },
      runUpdates: { id: "run_test", status: "running", activeParticipantId: "part_01" },
    });

    const r = makeCtrl(p).recoverRoleBasedRuns({ now: () => NOW_MS });
    expect(r.budgetExhaustedAtRecovery).toBe(1);
    expect(p.getRun("run_test")!.status).toBe("budget_exhausted");
  });
});

// ============================================================
// Section 2: deriveRoleExecutionCursor
// ============================================================

describe("deriveRoleExecutionCursor", () => {
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
    });
    const parts = [makePersisted({ sequenceIndex: 0 }), makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1 })];
    const c = deriveRoleExecutionCursor(run, parts, [makeCompletedTurn()], []);
    expect(c.sequenceIndex).toBe(1);
    expect(c.round).toBe(0);
  });

  it("daemon_restarted turn → interruptedTurnReplayRequired=true, seqIdx unchanged", () => {
    const c = deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [makeDaemonRestartedTurn()], []);
    expect(c.interruptedTurnReplayRequired).toBe(true);
    expect(c.interruptedParticipantId).toBe("part_01");
    expect(c.sequenceIndex).toBe(0);
  });

  it("daemon_restarted cleared by subsequent successful turn", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "once" },
    });
    const parts = [makePersisted({ sequenceIndex: 0 }), makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1 })];
    const turns = [
      makeDaemonRestartedTurn({ id: "t0", turnIndex: 0 }),
      makeCompletedTurn({ id: "t1", turnIndex: 1 }),
    ];
    const c = deriveRoleExecutionCursor(run, parts, turns, []);
    expect(c.interruptedTurnReplayRequired).toBe(false);
    expect(c.sequenceIndex).toBe(1);
  });

  it("repeat_until_done: full round → round increments, seqIdx wraps to 0", () => {
    const run = makeRun({
      status: "paused",
      policy: { roleSequence: ["architect", "implementer"], terminalRoles: ["implementer"], loopMode: "repeat_until_done" },
    });
    const parts = [makePersisted({ sequenceIndex: 0 }), makePersisted({ id: "part_02", roleId: "implementer", sequenceIndex: 1 })];
    const turns = [
      makeCompletedTurn({ id: "t0", turnIndex: 0, participantId: "part_01" }),
      makeCompletedTurn({ id: "t1", turnIndex: 1, participantId: "part_02", roleId: "implementer" }),
    ];
    const c = deriveRoleExecutionCursor(run, parts, turns, []);
    expect(c.round).toBe(1);
    expect(c.sequenceIndex).toBe(0);
  });

  it("throws on turn index gap", () => {
    const turns = [makeCompletedTurn({ id: "t0", turnIndex: 0 }), makeCompletedTurn({ id: "t2", turnIndex: 2 })];
    expect(() => deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], turns, []))
      .toThrow("turn index gap");
  });

  it("throws on message sequence gap", () => {
    const msg0 = makeMessage({ id: "cmsg_00", sequenceIndex: 0 });
    const msg2 = { ...makeMessage({ id: "cmsg_02", content: "second" }), sequenceIndex: 2 };
    expect(() => deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [], [msg0, msg2]))
      .toThrow("message sequence gap");
  });

  it("throws when startedAt is missing", () => {
    const run = makeRun({ status: "paused", startedAt: undefined });
    expect(() => deriveRoleExecutionCursor(run, [makePersisted()], [], []))
      .toThrow("startedAt timestamp");
  });

  it("populates priorTurns from canonical messages", () => {
    const msg = makeMessage({ decisionType: "message", content: "Architecture plan" });
    const c = deriveRoleExecutionCursor(makeRun({ status: "paused" }), [makePersisted()], [makeCompletedTurn()], [msg]);
    expect(c.priorTurns).toHaveLength(1);
    expect(c.priorTurns[0]!.participantId).toBe("part_01");
  });
});

// ============================================================
// Section 3: resumeRoleBasedRun validation guards
// ============================================================

describe("resumeRoleBasedRun validation", () => {
  it("rejects when run not found", async () => {
    await expect(makeCtrl(new InMemoryRoleBasedRunPersistence()).resumeRoleBasedRun("run_x"))
      .rejects.toThrow("not found");
  });

  it("rejects when run is not paused (running)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ status: "running" }), [PLAN]);
    await expect(makeCtrl(p).resumeRoleBasedRun("run_test")).rejects.toThrow("must be 'paused'");
  });

  it("rejects when run is terminal (completed)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun(), [PLAN]);
    p.finalizeRun("run_test", { status: "completed", completedAt: NOW_ISO });
    await expect(makeCtrl(p).resumeRoleBasedRun("run_test")).rejects.toThrow("must be 'paused'");
  });

  it("requires replay confirmation when last turn is daemon_restarted", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: "part_01" }), [PLAN]);
    const ctrl = makeCtrl(p);
    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS });

    expect(p.getRun("run_test")!.status).toBe("paused");
    await expect(ctrl.resumeRoleBasedRun("run_test")).rejects.toThrow("allowReplayInterruptedTurn=true");
  });

  it("rejects concurrent double-resume (resume_in_progress)", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    p.createInitialRun(makeRun({ activeParticipantId: undefined }), [PLAN]);

    // stalled adapter — never resolves
    let resolveAdapter!: (v: any) => void;
    const stalledAdapter: ExternalAgentAdapter = {
      initialize: async () => {},
      executeAgentTurn: () => new Promise(r => { resolveAdapter = r; }),
      close: async () => { resolveAdapter?.({ type: "done", summary: "closed" }); },
    } as any;

    const ctrl = new RunController(
      makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(),
      p,
      (_participants) => ({
        plans: [PLAN],
        runtimes: [{ participantId: "part_01", roleId: "architect", adapter: stalledAdapter }],
        records: { participantIds: ["part_01"], participantsById: { part_01: makeRun().participantsById["part_01"]! } },
      } as any),
    );
    ctrl.recoverRoleBasedRuns(); // safe boundary → paused

    const r1 = ctrl.resumeRoleBasedRun("run_test");
    await expect(ctrl.resumeRoleBasedRun("run_test")).rejects.toThrow("already being resumed");
    resolveAdapter?.({ type: "done", summary: "done" });
    await r1.catch(() => {});
  });

  it("rejects when wall-clock budget is expired", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    // started 2 hours ago, 1 hour budget
    const startedAt = new Date(Date.now() - 7_200_000).toISOString();
    p.createInitialRun(
      makeRun({
        startedAt,
        budget: { maxTurns: 20, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 3_600_000 },
      }),
      [PLAN],
    );
    p.finalizeRun("run_test", { status: "paused", activeParticipantId: null });
    await expect(makeCtrl(p).resumeRoleBasedRun("run_test")).rejects.toThrow("wall-clock budget exhausted");
  });

  it("allowReplayInterruptedTurn=true permits resume after daemon_restarted", async () => {
    const p = new InMemoryRoleBasedRunPersistence();
    // Use current time as startedAt so wall-clock budget is not exhausted
    const freshStartedAt = new Date().toISOString();
    p.createInitialRun(
      makeRun({
        activeParticipantId: "part_01",
        startedAt: freshStartedAt,
        budget: { maxTurns: 20, maxParticipants: 2, maxParallelTurns: 1, maxRetriesPerParticipant: 3, maxWallClockMs: 3_600_000 },
      }),
      [PLAN],
    );

    const doneAdapter: ExternalAgentAdapter = {
      initialize: async () => {},
      executeAgentTurn: async () => ({ type: "done", summary: "resumed and done" } as any),
      close: async () => {},
    } as any;

    const ctrl = new RunController(
      makeRunStore(), makeSessionManager(), makeAuditStore(), (_id) => makeAdapter(),
      p,
      (_participants) => ({
        plans: [PLAN],
        runtimes: [{ participantId: "part_01", roleId: "architect", adapter: doneAdapter, recreateAdapter: undefined }],
        records: { participantIds: ["part_01"], participantsById: { part_01: makeRun().participantsById["part_01"]! } },
      } as any),
    );

    ctrl.recoverRoleBasedRuns({ now: () => NOW_MS });
    expect(p.getRun("run_test")!.status).toBe("paused");

    const resumed = await ctrl.resumeRoleBasedRun("run_test", { allowReplayInterruptedTurn: true });
    expect(resumed.status).toBe("running");

    // Wait for settlement
    const settlement = (ctrl as any).roleRunSettlements?.get?.("run_test") as Promise<any> | undefined;
    if (settlement) await settlement.catch(() => {});

    const final = p.getRun("run_test")!;
    expect(["completed", "failed", "paused", "timed_out", "budget_exhausted"]).toContain(final.status);
  });
});

// ============================================================
// Section 4: InMemoryRoleBasedRunPersistence recovery methods
// ============================================================

describe("InMemoryRoleBasedRunPersistence", () => {
  describe("getParticipants", () => {
    it("returns empty for unknown runId", () => {
      expect(new InMemoryRoleBasedRunPersistence().getParticipants("none")).toHaveLength(0);
    });

    it("returns participants sorted by sequenceIndex ASC", () => {
      const p = new InMemoryRoleBasedRunPersistence();
      p.createInitialRun(makeRun({
        participantIds: ["part_02", "part_01"],
        participantsById: {
          part_02: { id: "part_02", roleId: "implementer", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
          part_01: { id: "part_01", roleId: "architect", adapterId: "subprocess-jsonl", status: "idle", turnsExecuted: 0, consecutiveFailures: 0, createdAt: NOW_ISO },
        },
      }), [
        { participantId: "part_01", roleId: "architect", role: ROLE_DEF, adapterId: "subprocess-jsonl", config: PART_CONFIG, sequenceIndex: 0 },
        { participantId: "part_02", roleId: "implementer", role: ROLE_DEF, adapterId: "subprocess-jsonl", config: PART_CONFIG, sequenceIndex: 1 },
      ]);
      const parts = p.getParticipants("run_test");
      expect(parts[0]!.sequenceIndex).toBe(0);
      expect(parts[1]!.sequenceIndex).toBe(1);
      expect(parts[0]!.id).toBe("part_01");
    });
  });

  describe("listRunsByStatuses", () => {
    it("returns empty for empty status list", () => {
      expect(new InMemoryRoleBasedRunPersistence().listRunsByStatuses([])).toHaveLength(0);
    });

    it("filters by single status", () => {
      const p = new InMemoryRoleBasedRunPersistence();
      p.createInitialRun(makeRun({ id: "run_a" } as any), [PLAN]);
      p.createInitialRun(makeRun({ id: "run_b" } as any), [PLAN]);
      p.finalizeRun("run_b", { status: "paused" });
      expect(p.listRunsByStatuses(["running"])).toHaveLength(1);
      expect(p.listRunsByStatuses(["paused"])).toHaveLength(1);
      expect(p.listRunsByStatuses(["running", "paused"])).toHaveLength(2);
    });
  });
});
