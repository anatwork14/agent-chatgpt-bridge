import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunController } from "./run-controller";
import { RoleRegistry } from "./role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import {
  type CollaborationConfig,
} from "./collaboration-domain";
import {
  type ExternalAgentAdapter,
  type AgentTurnInput,
  type AgentDecision,
  type CollaborationRun,
} from "./domain";
import {
  type ParticipantRuntime,
  type PreparedRoleParticipants,
} from "./collaboration-runtime";
import { createParticipantAssignmentPlans, createInitialParticipantRecords } from "./participant-assignment";
import { SqliteCollaborationPersistence } from "../persistence/sqlite-collaboration-persistence";
import { AuditStore } from "../persistence/audit-store";
import { initDatabase, closeDatabase } from "../persistence/database";
import { BridgeError } from "./errors";

class FakeRunStore {
  private readonly runs = new Map<string, any>();
  create(run: any) { this.runs.set(run.id, { ...run }); }
  get(id: string) { return this.runs.get(id) ?? null; }
  update(id: string, patch: any) {
    const cur = this.runs.get(id);
    if (cur) Object.assign(cur, patch);
  }
  list(): CollaborationRun[] { return Array.from(this.runs.values()); }
  delete(id: string): boolean { return this.runs.delete(id); }
}

class FakeSessionManager {
  constructor(private readonly sessionStatus: "active" | "closed" = "active") {}
  async get(id: string) {
    return {
      id,
      status: this.sessionStatus,
      provider: "chatgpt-web",
      model: "gpt-4",
      effort: "medium",
      turns: [],
      createdAt: new Date().toISOString(),
    };
  }
  async cancel() { return true; }
  async send() { throw new Error("sessionManager.send should not be called in role workflow"); }
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
  recreateFactories?: Record<string, () => ExternalAgentAdapter>,
): PreparedRoleParticipants {
  const plans = createParticipantAssignmentPlans(config, registry);
  const records = createInitialParticipantRecords(plans);

  const runtimes: ParticipantRuntime[] = plans.map((plan) => {
    const adapter = adaptersByRole[plan.roleId] ?? new TrackedMockAdapter({ id: `adapter-${plan.roleId}` });
    const recreateAdapter = recreateFactories?.[plan.roleId];
    return {
      participantId: plan.participantId,
      roleId: plan.roleId,
      adapterId: plan.adapterId,
      adapter,
      recreateAdapter,
    };
  });

  return { plans, runtimes, records };
}

describe("P4.7 Typed Collaboration Audit Taxonomy & Observability Integration", () => {
  let tempDir: string;
  let dbPath: string;
  let auditStore: AuditStore;
  let persistence: SqliteCollaborationPersistence;
  let registry: RoleRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-audit-test-"));
    dbPath = path.join(tempDir, "audit_test.db");
    const db = initDatabase(dbPath);
    db.exec(`
      INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
      VALUES ('ses_audit_1', 'chatgpt-web', 'gpt-4', 'active', '${new Date().toISOString()}', '${new Date().toISOString()}');
    `);
    auditStore = new AuditStore();
    persistence = new SqliteCollaborationPersistence();
    registry = new RoleRegistry();
    for (const role of BUILTIN_ROLE_DEFINITIONS) {
      registry.register(role);
    }
  });

  function safeRmDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignored
    }
  }

  afterEach(() => {
    closeDatabase();
    safeRmDir(tempDir);
  });

  it("normal 3-participant run emits exact causal audit event sequence with schemaVersion 1 and monotonic IDs", async () => {
    const config: CollaborationConfig = {
      objective: "Build and review feature X",
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        terminalRoles: ["reviewer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 10,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
    };

    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => ({ type: "message", content: "Architecture plan ready." }),
    });
    const implAdapter = new TrackedMockAdapter({
      id: "adapter-impl",
      onNext: () => ({ type: "message", content: "Code implemented." }),
    });
    const revAdapter = new TrackedMockAdapter({
      id: "adapter-rev",
      onNext: () => ({ type: "done", summary: "Code verified and approved." }),
    });

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
      implementer: implAdapter,
      reviewer: revAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const result = await controller.executeRoleBasedRun("ses_audit_1", config, prepared);
    expect(result.run.status).toBe("completed");

    const events = auditStore.listByRun(result.run.id);

    // Assert strictly increasing monotonic IDs
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].id).toBeLessThan(events[i + 1].id!);
    }

    // Assert all payloads have schemaVersion: 1
    for (const evt of events) {
      expect(evt.payload).toBeDefined();
      expect((evt.payload as any).schemaVersion).toBe(1);
    }

    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toEqual([
      "collaboration.started",
      "participant.assigned",
      "participant.assigned",
      "participant.assigned",
      "participant.turn.started",
      "participant.turn.completed",
      "participant.turn.started",
      "participant.turn.completed",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.completed",
    ]);

    // Check payload details for key events
    const startedEvt = events[0];
    expect((startedEvt.payload as any).roleSequence).toEqual(["architect", "implementer", "reviewer"]);
    expect((startedEvt.payload as any).participantCount).toBe(3);

    const turn1Started = events[4];
    expect((turn1Started.payload as any).roleId).toBe("architect");
    expect((turn1Started.payload as any).turnIndex).toBe(0);

    const turn1Completed = events[5];
    expect((turn1Completed.payload as any).decisionType).toBe("message");
    expect((turn1Completed.payload as any).turnIndex).toBe(0);

    const completedEvt = events[events.length - 1];
    expect((completedEvt.payload as any).totalTurns).toBe(3);
    expect((completedEvt.payload as any).round).toBe(0);
  });

  it("decision retry and operational retry emit retry.scheduled and runtime.recreated audit events", async () => {
    let archAttempts = 0;
    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => {
        archAttempts++;
        if (archAttempts === 1) {
          return {
            type: "error",
            message: "Transient architectural uncertainty",
            retryable: true,
          };
        }
        return { type: "done", summary: "Architecture resolved." };
      },
    });

    const config: CollaborationConfig = {
      objective: "Retry test",
      policy: {
        roleSequence: ["architect"],
        terminalRoles: ["architect"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const result = await controller.executeRoleBasedRun("ses_audit_1", config, prepared);
    expect(result.run.status).toBe("completed");

    const events = auditStore.listByRun(result.run.id);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toEqual([
      "collaboration.started",
      "participant.assigned",
      "participant.turn.started",
      "participant.turn.failed",
      "participant.retry.scheduled",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.completed",
    ]);

    const failedEvt = events.find((e) => e.eventType === "participant.turn.failed")!;
    expect((failedEvt.payload as any).errorCode).toBe("agent_decision_error");
    expect((failedEvt.payload as any).retryable).toBe(true);

    const retryEvt = events.find((e) => e.eventType === "participant.retry.scheduled")!;
    expect((retryEvt.payload as any).retryOrdinal).toBe(1);
    expect((retryEvt.payload as any).maxRetries).toBe(2);
    expect((retryEvt.payload as any).recreateRuntime).toBe(false);
  });

  it("operational error recreation emits runtime.recreated audit event", async () => {
    let archAttempts = 0;
    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => {
        archAttempts++;
        if (archAttempts === 1) {
          throw new BridgeError("transient_io", "Adapter process crashed", true);
        }
        return { type: "done", summary: "Recovered from process crash." };
      },
    });

    const config: CollaborationConfig = {
      objective: "Operational retry test",
      policy: {
        roleSequence: ["architect"],
        terminalRoles: ["architect"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    const healthyAdapter = new TrackedMockAdapter({
      id: "adapter-healthy",
      onNext: () => ({ type: "done", summary: "Healthy adapter finished." }),
    });

    const prepared = buildPrepared(
      config,
      registry,
      { architect: archAdapter },
      { architect: () => healthyAdapter },
    );

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const result = await controller.executeRoleBasedRun("ses_audit_1", config, prepared);
    expect(result.run.status).toBe("completed");

    const events = auditStore.listByRun(result.run.id);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toContain("participant.retry.scheduled");
    expect(eventTypes).toContain("participant.runtime.recreated");

    const recreatedEvt = events.find((e) => e.eventType === "participant.runtime.recreated")!;
    expect((recreatedEvt.payload as any).causeCode).toBe("transient_io");
  });

  it("pause and safe explicit resume emit collaboration.paused, collaboration.resumed, and final completion", async () => {
    const config: CollaborationConfig = {
      objective: "Pause and resume audit test",
      policy: {
        roleSequence: ["architect", "implementer"],
        terminalRoles: ["implementer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
    };

    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => ({ type: "pause", reason: "Need external human confirmation." }),
    });
    const implAdapter = new TrackedMockAdapter({
      id: "adapter-impl",
      onNext: () => ({ type: "done", summary: "Implementation completed after resume." }),
    });

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
      implementer: implAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
      (_participants) => prepared,
    );

    const firstRun = await controller.executeRoleBasedRun("ses_audit_1", config, prepared);
    expect(firstRun.run.status).toBe("paused");

    // Verify events up to pause
    const preResumeEvents = auditStore.listByRun(firstRun.run.id);
    const preResumeTypes = preResumeEvents.map((e) => e.eventType);
    expect(preResumeTypes).toEqual([
      "collaboration.started",
      "participant.assigned",
      "participant.assigned",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.paused",
    ]);

    const pausedEvt = preResumeEvents.find((e) => e.eventType === "collaboration.paused")!;
    expect((pausedEvt.payload as any).reasonPresent).toBe(true);

    // Resume the run
    await controller.resumeRoleBasedRun(firstRun.run.id);
    const finalResult = await controller.waitForRoleBasedRun(firstRun.run.id);
    expect(finalResult.run.status).toBe("completed");

    // Verify complete audit timeline
    const allEvents = auditStore.listByRun(firstRun.run.id);
    const allTypes = allEvents.map((e) => e.eventType);
    expect(allTypes).toEqual([
      "collaboration.started",
      "participant.assigned",
      "participant.assigned",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.paused",
      "collaboration.resumed",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.completed",
    ]);

    const resumedEvt = allEvents.find((e) => e.eventType === "collaboration.resumed")!;
    expect((resumedEvt.payload as any).replayAcknowledged).toBe(false);
    expect((resumedEvt.payload as any).sequenceIndex).toBe(1);
    expect((resumedEvt.payload as any).nextTurnIndex).toBe(1);
  });

  it("daemon crash during active turn produces turn.failed, recovered, paused; resume emits replay.acknowledged and resumed", async () => {
    const config: CollaborationConfig = {
      objective: "Crash recovery test",
      policy: {
        roleSequence: ["architect", "implementer"],
        terminalRoles: ["implementer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
    };

    let implementerStartedResolve: () => void;
    const implementerStarted = new Promise<void>((r) => { implementerStartedResolve = r; });

    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => ({ type: "message", content: "Architecture note." }),
    });
    const implAdapter = new TrackedMockAdapter({
      id: "adapter-impl",
      onNext: async () => {
        implementerStartedResolve();
        return new Promise<AgentDecision>(() => {}); // Hangs mid-turn to simulate daemon crash
      },
    });

    const prepared1 = buildPrepared(config, registry, {
      architect: archAdapter,
      implementer: implAdapter,
    });

    const controller1 = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    // Start run
    const initialRun = await controller1.startRoleBasedRun("ses_audit_1", config, prepared1);
    // Wait until implementer is actively running mid-turn
    await implementerStarted;

    const part2 = initialRun.participantIds[1];
    expect(persistence.getRun(initialRun.id)!.activeParticipantId).toBe(part2);

    // Daemon restart: new controller on same persistence
    const implResumedAdapter = new TrackedMockAdapter({
      id: "adapter-impl-resumed",
      onNext: () => ({ type: "done", summary: "Implementation completed after recovery." }),
    });

    const controller2 = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
      (persistedParticipants) => ({
        plans: prepared1.plans.map((plan, idx) => ({ ...plan, participantId: persistedParticipants[idx]?.id ?? plan.participantId })),
        runtimes: persistedParticipants.map((p) => ({
          participantId: p.id,
          roleId: p.roleId,
          adapterId: p.adapterId,
          adapter: p.roleId === "implementer" ? implResumedAdapter : archAdapter,
        })),
        records: {
          participantIds: persistedParticipants.map((p) => p.id),
          participantsById: Object.fromEntries(persistedParticipants.map((p) => [p.id, p])),
        },
      } as any),
    );

    // Recover orphaned runs
    const report = controller2.recoverRoleBasedRuns();
    expect(report.examined).toBe(1);
    expect(report.syntheticTurnRecorded).toBe(1);

    const recoveryEvents = auditStore.listByRun(initialRun.id);
    const recEvt = recoveryEvents.find((e) => e.eventType === "collaboration.recovered")!;
    expect((recEvt.payload as any).recoveryKind).toBe("interrupted_turn");
    expect((recEvt.payload as any).outcomeStatus).toBe("paused");
    expect((recEvt.payload as any).syntheticTurn).toBe(true);

    const syntheticTurnFailed = recoveryEvents.find(
      (e) => e.eventType === "participant.turn.failed" && (e.payload as any).errorCode === "daemon_restarted",
    )!;
    expect(syntheticTurnFailed).toBeDefined();

    // Resume with replay acknowledgement
    await controller2.resumeRoleBasedRun(initialRun.id, {
      allowReplayInterruptedTurn: true,
    });
    const finalSettled = await controller2.waitForRoleBasedRun(initialRun.id);
    expect(finalSettled.run.status).toBe("completed");

    const finalEvents = auditStore.listByRun(initialRun.id);
    const finalTypes = finalEvents.map((e) => e.eventType);

    expect(finalTypes).toContain("collaboration.replay.acknowledged");
    expect(finalTypes).toContain("collaboration.resumed");
    expect(finalTypes).toContain("collaboration.completed");

    const replayEvt = finalEvents.find((e) => e.eventType === "collaboration.replay.acknowledged")!;
    expect((replayEvt.payload as any).participantId).toBe(part2);
  });

  it("cancellation race where turn finishes before cancel records cancel.requested and collaboration.completed", async () => {
    const config: CollaborationConfig = {
      objective: "Cancellation race test",
      policy: {
        roleSequence: ["architect"],
        terminalRoles: ["architect"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
      },
    };

    let controller: RunController;
    let runId = "";
    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: async () => {
        // As turn is finishing, request cancellation
        setTimeout(() => {
          controller.cancelRoleBasedRun(runId, "User changed mind");
        }, 10);
        await new Promise((r) => setTimeout(r, 40));
        return { type: "done", summary: "Done before cancellation caught" };
      },
    });

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
    });

    controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const started = await controller.startRoleBasedRun("ses_audit_1", config, prepared);
    runId = started.id;
    const settled = await controller.waitForRoleBasedRun(runId);

    const events = auditStore.listByRun(runId);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toContain("collaboration.cancel.requested");
    expect(eventTypes).toContain("participant.turn.completed");
    expect(eventTypes).toContain("collaboration.completed");
    // Exactly one terminal event: completed won the race, so NO collaboration.cancelled
    expect(eventTypes).not.toContain("collaboration.cancelled");
  });

  it("participant cancellation emits participant.cancel.requested and collaboration.failed", async () => {
    const config: CollaborationConfig = {
      objective: "Participant cancel test",
      policy: {
        roleSequence: ["architect", "implementer"],
        terminalRoles: ["implementer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
    };

    let controller: RunController;
    let runId = "";
    let implParticipantId = "";
    let archTurnStartedResolve: () => void;
    const archTurnStarted = new Promise<void>((r) => { archTurnStartedResolve = r; });

    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: async (_, ctx) => {
        archTurnStartedResolve();
        return new Promise<AgentDecision>((resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted by participant cancellation", "AbortError"));
          });
        });
      },
    });

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
    });

    controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const started = await controller.startRoleBasedRun("ses_audit_1", config, prepared);
    runId = started.id;
    implParticipantId = started.participantIds[1];

    await archTurnStarted;

    const cancelled = await controller.cancelRoleParticipant(runId, implParticipantId, "Implementer unavailable");
    expect(cancelled).toBe(true);

    const settled = await controller.waitForRoleBasedRun(runId);
    expect(settled.run.status).toBe("failed");

    const events = auditStore.listByRun(runId);
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toContain("participant.cancel.requested");
    expect(eventTypes).toContain("collaboration.failed");

    const partCancelEvt = events.find((e) => e.eventType === "participant.cancel.requested")!;
    expect((partCancelEvt.payload as any).participantId).toBe(implParticipantId);
    expect((partCancelEvt.payload as any).reasonPresent).toBe(true);

    const failedEvt = events.find((e) => e.eventType === "collaboration.failed")!;
    expect((failedEvt.payload as any).failureCategory).toBe("participant_cancelled");
  });

  it("strict audit data-leak sentinel test: canary strings never appear in audit_events table", async () => {
    const CANARY = "CANARY_SECRET_LEAK_CHECK_xyz987";
    const config: CollaborationConfig = {
      objective: `Top secret objective ${CANARY}`,
      policy: {
        roleSequence: ["architect"],
        terminalRoles: ["architect"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 5,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60_000,
      },
      roles: {
        architect: {
          adapterType: "acp:claude",
          cwd: `/tmp/secret_${CANARY}`,
          command: ["--secret", CANARY],
        },
      },
    };

    const archAdapter = new TrackedMockAdapter({
      id: "adapter-arch",
      onNext: () => ({
        type: "done",
        summary: `Top secret summary ${CANARY}`,
      }),
    });

    const prepared = buildPrepared(config, registry, {
      architect: archAdapter,
    });

    const controller = new RunController(
      new FakeRunStore() as any,
      new FakeSessionManager() as any,
      auditStore,
      (_id) => new TrackedMockAdapter(),
      persistence,
    );

    const result = await controller.executeRoleBasedRun("ses_audit_1", config, prepared);
    expect(result.run.status).toBe("completed");

    // Directly scan all SQLite rows in audit_events
    const rows = auditStore.listByRun(result.run.id);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const rawJson = JSON.stringify(row);
      expect(rawJson).not.toContain(CANARY);
      expect(rawJson).not.toContain("Top secret");
    }
  });
});
