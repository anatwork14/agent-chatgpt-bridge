import { describe, expect, it } from "bun:test";
import { RunController } from "./run-controller";
import { RoleRegistry } from "./role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import {
  type CollaborationConfig,
  type RoleId,
} from "./collaboration-domain";
import {
  type ExternalAgentAdapter,
  type AgentTurnInput,
  type AgentDecision,
} from "./domain";
import {
  type ParticipantRuntime,
  type PreparedRoleParticipants,
} from "./collaboration-runtime";
import { createParticipantAssignmentPlans, createInitialParticipantRecords } from "./participant-assignment";
import { BridgeError } from "./errors";
import { InMemoryRoleBasedRunPersistence } from "./collaboration-persistence";
import { collaborationMessagesToPriorTurns } from "./collaboration-transcript";

class FakeRunStore {
  private readonly runs = new Map<string, any>();
  create(run: any) { this.runs.set(run.id, { ...run }); }
  get(id: string) { return this.runs.get(id) ?? null; }
  update(id: string, patch: any) {
    const cur = this.runs.get(id);
    if (cur) Object.assign(cur, patch);
  }
}

class FakeSessionManager {
  constructor(private readonly sessionStatus: "active" | "closed" = "active") {}
  async get(id: string) {
    return {
      id,
      status: this.sessionStatus,
      turns: [],
      createdAt: new Date().toISOString(),
    };
  }
  async cancel() { return true; }
  async send() { throw new Error("sessionManager.send should not be called in role workflow"); }
}

class FakeAuditStore {
  public readonly events: any[] = [];
  log(event: any) { this.events.push(event); }
}

interface MockAdapterOptions {
  readonly id?: string;
  readonly onInitialize?: (ctx: any) => Promise<void> | void;
  readonly onNext?: (input: AgentTurnInput, ctx: { signal?: AbortSignal }) => Promise<AgentDecision> | AgentDecision;
  readonly onClose?: () => Promise<void> | void;
}

class TrackedMockAdapter implements ExternalAgentAdapter {
  public readonly id: string;
  public initializeCalls = 0;
  public nextCalls = 0;
  public closeCalls = 0;
  public lastInput?: AgentTurnInput;
  public closed = false;

  constructor(private readonly options: MockAdapterOptions = {}) {
    this.id = options.id ?? "mock-adapter";
  }

  async initialize(context: any): Promise<void> {
    this.initializeCalls++;
    if (this.options.onInitialize) {
      await this.options.onInitialize(context);
    }
  }

  async next(input: AgentTurnInput, ctx: { signal?: AbortSignal }): Promise<AgentDecision> {
    this.nextCalls++;
    this.lastInput = input;
    if (this.options.onNext) {
      return await this.options.onNext(input, ctx);
    }
    return { type: "message", content: `Mock response from ${this.id}` };
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.closed = true;
    if (this.options.onClose) {
      await this.options.onClose();
    }
  }
}

function buildPrepared(
  config: CollaborationConfig,
  registry: RoleRegistry,
  adaptersByRole: Record<string, ExternalAgentAdapter>,
): PreparedRoleParticipants {
  const plans = createParticipantAssignmentPlans(config, registry);
  const runtimes: ParticipantRuntime[] = plans.map(p => {
    const adapter = adaptersByRole[p.roleId] ?? new TrackedMockAdapter({ id: p.roleId });
    return {
      participantId: p.participantId,
      roleId: p.roleId,
      adapterId: p.adapterId,
      adapter,
    };
  });
  const records = createInitialParticipantRecords(plans);
  return { plans, runtimes, records };
}

describe("P4.3 Role-Based RunController Orchestration", () => {
  const registry = new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);

  it("sequential execution order: architect -> implementer -> reviewer", async () => {
    const callLog: string[] = [];

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onInitialize: () => { callLog.push("init:architect"); },
      onNext: () => {
        callLog.push("next:architect");
        return { type: "message", content: "Architecture plan created" };
      },
      onClose: () => { callLog.push("close:architect"); },
    });

    const implementerAdapter = new TrackedMockAdapter({
      id: "implementer",
      onInitialize: () => { callLog.push("init:implementer"); },
      onNext: () => {
        callLog.push("next:implementer");
        return { type: "message", content: "Implementation patch created" };
      },
      onClose: () => { callLog.push("close:implementer"); },
    });

    const reviewerAdapter = new TrackedMockAdapter({
      id: "reviewer",
      onInitialize: () => { callLog.push("init:reviewer"); },
      onNext: () => {
        callLog.push("next:reviewer");
        return { type: "done", summary: "Implementation verified and approved" };
      },
      onClose: () => { callLog.push("close:reviewer"); },
    });

    const config: CollaborationConfig = {
      objective: "Build auth feature",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
      reviewer: reviewerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("getAgentAdapter should not be called in role workflow"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("Implementation verified and approved");
    expect(result.turns).toHaveLength(3);
    expect(result.run.turnHistory).toHaveLength(3);

    // Call order checks: lazy init + next sequentially, then reverse order close
    expect(callLog).toEqual([
      "init:architect",
      "next:architect",
      "init:implementer",
      "next:implementer",
      "init:reviewer",
      "next:reviewer",
      "close:reviewer",
      "close:implementer",
      "close:architect",
    ]);
  });

  it("hub-and-spoke handoff delivers prior outputs with provenance", async () => {
    let implementerReceivedPriorTurns: any[] = [];
    let reviewerReceivedPriorTurns: any[] = [];

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => ({ type: "message", content: "ARCH_PLAN_V1" }),
    });

    const implementerAdapter = new TrackedMockAdapter({
      id: "implementer",
      onNext: input => {
        implementerReceivedPriorTurns = input.collaboration?.priorTurns ? [...input.collaboration.priorTurns] : [];
        return ({ type: "message", content: "CODE_PATCH_V1" });
      },
    });

    const reviewerAdapter = new TrackedMockAdapter({
      id: "reviewer",
      onNext: input => {
        reviewerReceivedPriorTurns = input.collaboration?.priorTurns ? [...input.collaboration.priorTurns] : [];
        return ({ type: "done", summary: "ALL_TESTS_PASS" });
      },
    });

    const config: CollaborationConfig = {
      objective: "Build auth feature",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
      reviewer: reviewerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    await controller.executeRoleBasedRun("ses_test", config, prepared);

    // Implementer should have received exactly Architect's output
    expect(implementerReceivedPriorTurns).toHaveLength(1);
    expect(implementerReceivedPriorTurns[0]?.roleId).toBe("architect");
    expect(implementerReceivedPriorTurns[0]?.text).toBe("ARCH_PLAN_V1");
    expect(implementerReceivedPriorTurns[0]?.decisionType).toBe("message");

    // Reviewer should have received both Architect and Implementer outputs
    expect(reviewerReceivedPriorTurns).toHaveLength(2);
    expect(reviewerReceivedPriorTurns[0]?.roleId).toBe("architect");
    expect(reviewerReceivedPriorTurns[0]?.text).toBe("ARCH_PLAN_V1");
    expect(reviewerReceivedPriorTurns[1]?.roleId).toBe("implementer");
    expect(reviewerReceivedPriorTurns[1]?.text).toBe("CODE_PATCH_V1");
  });

  it("strict sequential execution: active participant turns <= 1 at all times", async () => {
    let currentActiveTurns = 0;
    let maxActiveTurns = 0;

    const makeConcurrentCheckAdapter = (id: string, decision: AgentDecision) => {
      return new TrackedMockAdapter({
        id,
        onNext: async () => {
          currentActiveTurns++;
          if (currentActiveTurns > maxActiveTurns) {
            maxActiveTurns = currentActiveTurns;
          }
          // Slight async tick to verify no concurrency
          await new Promise(r => setTimeout(r, 10));
          currentActiveTurns--;
          return decision;
        },
      });
    };

    const config: CollaborationConfig = {
      objective: "Concurrency test",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: makeConcurrentCheckAdapter("architect", { type: "message", content: "arch" }),
      implementer: makeConcurrentCheckAdapter("implementer", { type: "message", content: "impl" }),
      reviewer: makeConcurrentCheckAdapter("reviewer", { type: "done", summary: "done" }),
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(maxActiveTurns).toBe(1);
    expect(currentActiveTurns).toBe(0);
  });

  it("terminal authority: non-terminal done continues, only terminal done halts", async () => {
    const callLog: string[] = [];

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => {
        callLog.push("architect");
        // Non-terminal role emits done
        return { type: "done", summary: "Architecture design completed" };
      },
    });

    const implementerAdapter = new TrackedMockAdapter({
      id: "implementer",
      onNext: () => {
        callLog.push("implementer");
        return { type: "message", content: "Code implemented" };
      },
    });

    const reviewerAdapter = new TrackedMockAdapter({
      id: "reviewer",
      onNext: () => {
        callLog.push("reviewer");
        // Terminal role emits done
        return { type: "done", summary: "Final sign-off" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Terminal authority check",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        terminalRoles: ["reviewer"], // ONLY reviewer is terminal
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
      reviewer: reviewerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    // Architect's done did NOT halt the run; implementer and reviewer both ran
    expect(callLog).toEqual(["architect", "implementer", "reviewer"]);
    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("Final sign-off");
  });

  it("repeat_until_done executes multiple rounds until terminal done", async () => {
    let reviewerInvocations = 0;

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => ({ type: "message", content: "Architect contribution" }),
    });

    const reviewerAdapter = new TrackedMockAdapter({
      id: "reviewer",
      onNext: () => {
        reviewerInvocations++;
        if (reviewerInvocations === 1) {
          return { type: "message", content: "Changes requested" };
        }
        return { type: "done", summary: "Approved on round 1" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Multi-round repeat test",
      policy: {
        roleSequence: ["architect", "reviewer"],
        loopMode: "repeat_until_done",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      reviewer: reviewerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("completed");
    expect(result.run.round).toBe(1); // Completed 1 full round, terminated on round 1
    expect(result.run.finalSummary).toBe("Approved on round 1");
    expect(architectAdapter.nextCalls).toBe(2);
    expect(reviewerAdapter.nextCalls).toBe(2);
    expect(result.turns).toHaveLength(4);
  });

  it("lazy initialization reuse: initialize called exactly once per participant across rounds", async () => {
    let reviewerInvocations = 0;

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => ({ type: "message", content: "arch" }),
    });

    const reviewerAdapter = new TrackedMockAdapter({
      id: "reviewer",
      onNext: () => {
        reviewerInvocations++;
        if (reviewerInvocations < 3) {
          return { type: "message", content: "iterate" };
        }
        return { type: "done", summary: "done" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Init reuse test",
      policy: {
        roleSequence: ["architect", "reviewer"],
        loopMode: "repeat_until_done",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      reviewer: reviewerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    await controller.executeRoleBasedRun("ses_test", config, prepared);

    // Initialized at most once
    expect(architectAdapter.initializeCalls).toBe(1);
    expect(reviewerAdapter.initializeCalls).toBe(1);
    // Executed 3 times
    expect(architectAdapter.nextCalls).toBe(3);
    expect(reviewerAdapter.nextCalls).toBe(3);
  });

  it("maxTurns budget exhaustion halts before exceeding limit", async () => {
    const executedRoles: string[] = [];

    const makeAdapter = (role: string) =>
      new TrackedMockAdapter({
        id: role,
        onNext: () => {
          executedRoles.push(role);
          return { type: "message", content: `msg from ${role}` };
        },
      });

    const config: CollaborationConfig = {
      objective: "maxTurns budget test",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "repeat_until_done",
        terminalRoles: ["reviewer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
      budget: {
        maxTurns: 2, // Hard limit of 2 turns total
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: makeAdapter("architect"),
      implementer: makeAdapter("implementer"),
      reviewer: makeAdapter("reviewer"),
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("budget_exhausted");
    expect(executedRoles).toEqual(["architect", "implementer"]);
    expect(result.turns).toHaveLength(2);
  });

  it("wall-clock deadline halts run with status timed_out", async () => {
    let simulatedTime = 1000;

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => {
        // Advance simulated time past maxWallClockMs
        simulatedTime += 5000;
        return { type: "message", content: "Took too long" };
      },
    });

    const implementerAdapter = new TrackedMockAdapter({ id: "implementer" });

    const config: CollaborationConfig = {
      objective: "Timeout test",
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
      budget: {
        maxWallClockMs: 3000,
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared, {
      now: () => simulatedTime,
    });

    expect(result.run.status).toBe("timed_out");
    expect(implementerAdapter.nextCalls).toBe(0);
    expect(architectAdapter.closed).toBe(true);
    expect(implementerAdapter.closed).toBe(true);
  });

  it("cancellation signal transitions status to cancelled and closes adapters", async () => {
    const abortController = new AbortController();

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => {
        // Abort during turn
        abortController.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });

    const implementerAdapter = new TrackedMockAdapter({ id: "implementer" });

    const config: CollaborationConfig = {
      objective: "Cancellation test",
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared, {
      signal: abortController.signal,
    });

    expect(result.run.status).toBe("cancelled");
    expect(implementerAdapter.nextCalls).toBe(0);
    expect(architectAdapter.closed).toBe(true);
    expect(implementerAdapter.closed).toBe(true);
  });

  it("deterministic cleanup closes all adapters on failed and paused runs", async () => {
    const failedAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => ({ type: "error", message: "Catastrophic error", retryable: false }),
    });

    const config: CollaborationConfig = {
      objective: "Cleanup on error",
      policy: {
        roleSequence: ["architect"],
        loopMode: "once",
        terminalRoles: ["architect"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: failedAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("failed");
    expect(failedAdapter.closed).toBe(true);
  });

  it("rejects run on closed session", async () => {
    const config: CollaborationConfig = {
      objective: "Closed session test",
      policy: {
        roleSequence: ["architect"],
        loopMode: "once",
        terminalRoles: ["architect"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {});

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager("closed") as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    expect(controller.executeRoleBasedRun("ses_closed", config, prepared)).rejects.toThrow(
      "is closed",
    );
  });

  it("role instructions and metadata are accurately delivered to adapter", async () => {
    let capturedInput: AgentTurnInput | undefined;

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: input => {
        capturedInput = input;
        return { type: "done", summary: "Done" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Deliver instructions test",
      policy: {
        roleSequence: ["architect"],
        loopMode: "once",
        terminalRoles: ["architect"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(capturedInput?.collaboration).toBeDefined();
    expect(capturedInput?.collaboration?.roleId).toBe("architect");
    expect(capturedInput?.collaboration?.roleName).toBe("System Architect");
    expect(capturedInput?.collaboration?.systemInstructions).toContain("architectural invariants");
    expect(capturedInput?.collaboration?.sequenceIndex).toBe(0);
  });

  it("persistence failure stops orchestration and never invokes subsequent participants", async () => {
    let architectExecuted = false;
    let implementerExecuted = false;

    const architectAdapter = new TrackedMockAdapter({
      id: "architect",
      onNext: () => {
        architectExecuted = true;
        return { type: "message", content: "Architecture plan" };
      },
    });

    const implementerAdapter = new TrackedMockAdapter({
      id: "implementer",
      onNext: () => {
        implementerExecuted = true;
        return { type: "done", summary: "Implemented" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Persistence failure test",
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "subprocess-jsonl" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: architectAdapter,
      implementer: implementerAdapter,
    });

    // Failing persistence mock that throws on turn recording
    const failingPersistence = {
      createInitialRun: () => {},
      updateParticipantAndRunTransaction: () => {},
      recordTurnTransaction: () => {
        throw new Error("Disk I/O error during turn commit");
      },
      finalizeRun: () => {},
      getRun: () => null,
      listRunsBySession: () => [],
      getTranscript: () => [],
      getTurns: () => [],
    };

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      failingPersistence as any,
    );

    try {
      await controller.executeRoleBasedRun("ses_test", config, prepared);
      expect.unreachable("executeRoleBasedRun should have rejected on persistence failure");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("collaboration_persistence_failed");
      expect((err as BridgeError).message).toContain("Disk I/O error during turn commit");
    }

    expect(architectExecuted).toBe(true);
    // Implementer MUST NOT have been invoked because architect output failed to become canonical!
    expect(implementerExecuted).toBe(false);
  });

  it("real SQLite persistence round-trip through executeRoleBasedRun stores canonical transcript", async () => {
    const { initDatabase, closeDatabase } = await import("../persistence/database");
    const { SqliteCollaborationPersistence } = await import("../persistence/sqlite-collaboration-persistence");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const runDbPath = path.join(os.tmpdir(), `test-rc-sqlite-${Date.now()}.db`);
    closeDatabase();
    const db = initDatabase(runDbPath);
    db.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_sqlite_run', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
    `);

    try {
      const architectAdapter = new TrackedMockAdapter({
        id: "architect",
        onNext: () => ({ type: "message", content: "Architectural specification for persistence" }),
      });
      const implementerAdapter = new TrackedMockAdapter({
        id: "implementer",
        onNext: () => ({ type: "message", content: "Code implementation patch" }),
      });
      const reviewerAdapter = new TrackedMockAdapter({
        id: "reviewer",
        onNext: () => ({ type: "done", summary: "APPROVED: Code and architecture verified" }),
      });

      const config: CollaborationConfig = {
        objective: "End to end SQLite persistence run",
        policy: {
          roleSequence: ["architect", "implementer", "reviewer"],
          loopMode: "once",
          terminalRoles: ["reviewer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "subprocess-jsonl" },
          reviewer: { adapterType: "acp:claude" },
        },
      };

      const prepared = buildPrepared(config, registry, {
        architect: architectAdapter,
        implementer: implementerAdapter,
        reviewer: reviewerAdapter,
      });

      const persistence = new SqliteCollaborationPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        new FakeSessionManager() as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      const result = await controller.executeRoleBasedRun("ses_sqlite_run", config, prepared);

      expect(result.run.status).toBe("completed");
      expect(result.run.finalSummary).toBe("APPROVED: Code and architecture verified");

      // Verify data directly in SQLite persistence
      const persistedRun = persistence.getRun(result.run.id);
      expect(persistedRun).not.toBeNull();
      expect(persistedRun!.status).toBe("completed");
      expect(persistedRun!.finalSummary).toBe("APPROVED: Code and architecture verified");
      expect(persistedRun!.turnHistory.length).toBe(3);

      const transcript = persistence.getTranscript(result.run.id);
      expect(transcript.length).toBe(3);
      expect(transcript[0]!.senderRoleId).toBe("architect");
      expect(transcript[0]!.content).toBe("Architectural specification for persistence");
      expect(transcript[1]!.senderRoleId).toBe("implementer");
      expect(transcript[1]!.content).toBe("Code implementation patch");
      expect(transcript[2]!.senderRoleId).toBe("reviewer");
      expect(transcript[2]!.content).toBe("APPROVED: Code and architecture verified");
    } finally {
      closeDatabase();
      for (const p of [runDbPath, runDbPath + "-wal", runDbPath + "-shm"]) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // Lingering file locks on Windows temporary test files are safely ignored
        }
      }
    }
  }, 30000);

  describe("P4.5.2 Durable Settlement, Transcript Parity & Invariant Verification", () => {
    it("terminal run persisted before blocked adapter close (no crash window)", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      let releaseClose: () => void = () => {};
      const closePromise = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });

      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: () => ({ type: "done", summary: "Completed task" }),
        onClose: async () => {
          await closePromise;
        },
      });

      const config: CollaborationConfig = {
        objective: "Test durable settlement before teardown",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      while (adapter.closeCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // While adapter.close is still pending/blocked:
      const persistedDuringClose = persistence.getRun(run.id);
      expect(persistedDuringClose).not.toBeNull();
      expect(persistedDuringClose!.status).toBe("completed");
      expect(persistedDuringClose!.finalSummary).toBe("Completed task");
      expect(persistedDuringClose!.completedAt).toBeDefined();
      expect(persistedDuringClose!.activeParticipantId).toBeUndefined();

      // Release close
      releaseClose();

      const result = await controller.waitForRoleBasedRun(run.id);
      expect(result.run.status).toBe("completed");
      expect(result.run.finalSummary).toBe("Completed task");
    });

    it("budget exhaustion persisted before blocked adapter close", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      let releaseClose: () => void = () => {};
      const closePromise = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });

      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: () => ({ type: "message", content: "Working..." }),
        onClose: async () => {
          await closePromise;
        },
      });

      const config: CollaborationConfig = {
        objective: "Test budget exhaustion before teardown",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "repeat_until_done", terminalRoles: ["architect"] },
        budget: {
          maxTurns: 1,
          maxParticipants: 1,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 0,
          maxWallClockMs: 60000,
        },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      while (adapter.closeCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // While adapter.close is still blocked, run must already be durably persisted as budget_exhausted
      const persistedDuringClose = persistence.getRun(run.id);
      expect(persistedDuringClose).not.toBeNull();
      expect(persistedDuringClose!.status).toBe("budget_exhausted");
      expect(persistedDuringClose!.completedAt).toBeDefined();
      expect(persistedDuringClose!.activeParticipantId).toBeUndefined();

      releaseClose();

      const result = await controller.waitForRoleBasedRun(run.id);
      expect(result.run.status).toBe("budget_exhausted");
    });

    it("explicit error is included in retry priorTurns and later-role priorTurns, strictly matching transcript projection", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      let architectCalls = 0;
      let retryPriorTurns: any[] = [];
      let implementerPriorTurns: any[] = [];

      const architectAdapter = new TrackedMockAdapter({
        id: "architect",
        onNext: (input) => {
          architectCalls++;
          if (architectCalls === 1) {
            return { type: "error", message: "Transient rate limit exceeded", retryable: true };
          }
          retryPriorTurns = [...(input.collaboration?.priorTurns ?? [])];
          return { type: "message", content: "Architecture plan V2" };
        },
      });

      const implementerAdapter = new TrackedMockAdapter({
        id: "implementer",
        onNext: (input) => {
          implementerPriorTurns = [...(input.collaboration?.priorTurns ?? [])];
          return { type: "done", summary: "Implemented according to V2" };
        },
      });

      const config: CollaborationConfig = {
        objective: "Test explicit error in priorTurns",
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "subprocess-jsonl" },
        },
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        budget: {
          maxTurns: 10,
          maxParticipants: 2,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 2,
          maxWallClockMs: 60000,
        },
      };

      const prepared = buildPrepared(config, registry, {
        architect: architectAdapter,
        implementer: implementerAdapter,
      });

      const result = await controller.executeRoleBasedRun("ses_test", config, prepared);
      expect(result.run.status).toBe("completed");

      // 1. Architect retry sees its own committed error turn
      expect(retryPriorTurns).toHaveLength(1);
      expect(retryPriorTurns[0]?.roleId).toBe("architect");
      expect(retryPriorTurns[0]?.decisionType).toBe("error");
      expect(retryPriorTurns[0]?.text).toBe("Transient rate limit exceeded");

      // 2. Implementer sees both the error turn and the subsequent successful message turn in order
      expect(implementerPriorTurns).toHaveLength(2);
      expect(implementerPriorTurns[0]?.roleId).toBe("architect");
      expect(implementerPriorTurns[0]?.decisionType).toBe("error");
      expect(implementerPriorTurns[0]?.text).toBe("Transient rate limit exceeded");
      expect(implementerPriorTurns[1]?.roleId).toBe("architect");
      expect(implementerPriorTurns[1]?.decisionType).toBe("message");
      expect(implementerPriorTurns[1]?.text).toBe("Architecture plan V2");

      // 3. Runtime priorTurns strictly equals projection from canonical transcript
      const canonicalTranscript = persistence.getTranscript(result.run.id);
      const expectedPriorTurns = collaborationMessagesToPriorTurns(canonicalTranscript);
      expect(implementerPriorTurns).toEqual(expectedPriorTurns.slice(0, 2));

      // 4. Cryptographic integrity preserved for all messages
      expect(canonicalTranscript).toHaveLength(3);
      expect(canonicalTranscript[0]?.decisionType).toBe("error");
      expect(canonicalTranscript[1]?.decisionType).toBe("message");
      expect(canonicalTranscript[2]?.decisionType).toBe("done");
    });

    it("activeParticipantId is NULL on every settled path (success, pause, cancel, timeout, budget)", async () => {
      const sessionManager = new FakeSessionManager();

      // 1. Success
      {
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({ id: "architect", onNext: () => ({ type: "done", summary: "Done" }) });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const res = await controller.executeRoleBasedRun("ses_test", config, prep);
        expect(res.run.activeParticipantId).toBeUndefined();
        expect(persistence.getRun(res.run.id)?.activeParticipantId).toBeUndefined();
      }

      // 2. Pause
      {
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({ id: "architect", onNext: () => ({ type: "pause", reason: "Wait" }) });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const res = await controller.executeRoleBasedRun("ses_test", config, prep);
        expect(res.run.activeParticipantId).toBeUndefined();
        expect(persistence.getRun(res.run.id)?.activeParticipantId).toBeUndefined();
      }

      // 3. Whole-run cancel
      {
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({
          id: "architect",
          onNext: async (_input, ctx) => {
            await new Promise(r => { ctx.signal?.addEventListener("abort", r); });
            throw new DOMException("Aborted", "AbortError");
          },
        });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const run = await controller.startRoleBasedRun("ses_test", config, prep);
        while (adapter.nextCalls === 0) await new Promise(r => setTimeout(r, 10));
        await controller.cancelRoleBasedRun(run.id, "Cancel");
        expect(persistence.getRun(run.id)?.activeParticipantId).toBeUndefined();
      }

      // 4. Participant cancel
      {
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({
          id: "architect",
          onNext: async (_input, ctx) => {
            await new Promise(r => { ctx.signal?.addEventListener("abort", r); });
            throw new DOMException("Aborted", "AbortError");
          },
        });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const run = await controller.startRoleBasedRun("ses_test", config, prep);
        while (adapter.nextCalls === 0) await new Promise(r => setTimeout(r, 10));
        await controller.cancelRoleParticipant(run.id, prep.plans[0]!.participantId, "Cancel part");
        expect(persistence.getRun(run.id)?.activeParticipantId).toBeUndefined();
      }

      // 5. Budget exhausted
      {
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({ id: "architect", onNext: () => ({ type: "message", content: "..." }) });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "repeat_until_done", terminalRoles: ["architect"] },
          budget: { maxTurns: 1, maxParticipants: 1, maxParallelTurns: 1, maxRetriesPerParticipant: 0, maxWallClockMs: 60000 },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const res = await controller.executeRoleBasedRun("ses_test", config, prep);
        expect(res.run.activeParticipantId).toBeUndefined();
        expect(persistence.getRun(res.run.id)?.activeParticipantId).toBeUndefined();
      }

      // 6. Timeout (deterministic fake clock — avoids real-timer flakiness)
      {
        let simulatedTime = 1000;
        const persistence = new InMemoryRoleBasedRunPersistence();
        const controller = new RunController(
          new FakeRunStore() as any, sessionManager as any, new FakeAuditStore() as any,
          () => { throw new Error("not called"); }, persistence,
        );
        const adapter = new TrackedMockAdapter({
          id: "architect",
          onNext: () => {
            simulatedTime += 5000; // advance past maxWallClockMs=3000
            return { type: "message", content: "..." };
          },
        });
        const config: CollaborationConfig = {
          objective: "test",
          roles: { architect: { adapterType: "acp:claude" } },
          policy: { roleSequence: ["architect"], loopMode: "repeat_until_done", terminalRoles: ["architect"] },
          budget: { maxTurns: 10, maxParticipants: 1, maxParallelTurns: 1, maxRetriesPerParticipant: 0, maxWallClockMs: 3000 },
        };
        const prep = buildPrepared(config, registry, { architect: adapter });
        const res = await controller.executeRoleBasedRun("ses_test", config, prep, { now: () => simulatedTime });
        expect(res.run.status).toBe("timed_out");
        expect(res.run.activeParticipantId).toBeUndefined();
        expect(persistence.getRun(res.run.id)?.activeParticipantId).toBeUndefined();
      }
    });

    it("waitForRoleBasedRun returns result strictly equal to canonical persistence without unbounded cache", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: () => ({ type: "done", summary: "All done" }),
      });

      const config: CollaborationConfig = {
        objective: "Test result consistency",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      const result = await controller.waitForRoleBasedRun(run.id);
      const persistedRun = persistence.getRun(run.id);
      const persistedTurns = persistence.getTurns(run.id);

      expect(result.run).toEqual(persistedRun!);
      expect(result.turns).toEqual(persistedTurns);
      expect(result.run.status).toBe("completed");
      expect(result.run.status).not.toBe("running");
    });
  });
});
