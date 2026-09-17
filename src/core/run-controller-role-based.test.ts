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
    );

    await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(capturedInput?.collaboration).toBeDefined();
    expect(capturedInput?.collaboration?.roleId).toBe("architect");
    expect(capturedInput?.collaboration?.roleName).toBe("System Architect");
    expect(capturedInput?.collaboration?.systemInstructions).toContain("architectural invariants");
    expect(capturedInput?.collaboration?.sequenceIndex).toBe(0);
  });
});
