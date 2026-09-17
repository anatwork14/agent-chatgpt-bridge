import { describe, expect, it } from "bun:test";
import { RunController } from "./run-controller";
import { RoleRegistry } from "./role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import {
  type CollaborationConfig,
  type RoleId,
  MAX_CANCELLATION_REASON_BYTES,
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
import { initDatabase, closeDatabase } from "../persistence/database";
import { SqliteCollaborationPersistence } from "../persistence/sqlite-collaboration-persistence";
import { InMemoryRoleBasedRunPersistence } from "./collaboration-persistence";

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
  public cancelCallCount = 0;
  constructor(private readonly sessionStatus: "active" | "closed" = "active") {}
  async get(id: string) {
    return {
      id,
      status: this.sessionStatus,
      turns: [],
      createdAt: new Date().toISOString(),
    };
  }
  async cancel() {
    this.cancelCallCount++;
    return true;
  }
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
  recreateFactories?: Record<string, () => ExternalAgentAdapter>,
): PreparedRoleParticipants {
  const plans = createParticipantAssignmentPlans(config, registry);
  const runtimes: ParticipantRuntime[] = plans.map(p => {
    const adapter = adaptersByRole[p.roleId] ?? new TrackedMockAdapter({ id: p.roleId });
    const recreateAdapter = recreateFactories?.[p.roleId];
    return {
      participantId: p.participantId,
      roleId: p.roleId,
      adapterId: p.adapterId,
      adapter,
      recreateAdapter,
    };
  });
  const records = createInitialParticipantRecords(plans);
  return { plans, runtimes, records };
}

describe("P4.5 Role-Based Run Cancellation and Failure Propagation", () => {
  const registry = new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);

  it("multi-run isolation: cancelling Run A leaves concurrent Run B unaffected", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let runABlockedResolve: () => void;
    const runABlocked = new Promise<void>(resolve => { runABlockedResolve = resolve; });

    let runBCompleted = false;

    const configA: CollaborationConfig = {
      objective: "Objective A",
      roles: {
        architect: { adapterType: "acp:claude" },
      },
      policy: {
        roleSequence: ["architect"],
        loopMode: "once",
        terminalRoles: ["architect"],
      },
    };

    const configB: CollaborationConfig = {
      objective: "Objective B",
      roles: {
        architect: { adapterType: "acp:claude" },
      },
      policy: {
        roleSequence: ["architect"],
        loopMode: "once",
        terminalRoles: ["architect"],
      },
    };

    const preparedA = buildPrepared(configA, registry, {
      architect: new TrackedMockAdapter({
        id: "architect-a",
        onNext: async (_, ctx) => {
          runABlockedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      }),
    });

    const preparedB = buildPrepared(configB, registry, {
      architect: new TrackedMockAdapter({
        id: "architect-b",
        onNext: async () => {
          runBCompleted = true;
          return { type: "done", summary: "Run B finished successfully" };
        },
      }),
    });

    const runA = await controller.startRoleBasedRun("ses_test", configA, preparedA);
    const runB = await controller.startRoleBasedRun("ses_test", configB, preparedB);

    // Wait until Run A is actively executing
    await runABlocked;

    // Cancel Run A
    const cancelled = await controller.cancelRoleBasedRun(runA.id);
    expect(cancelled).toBe(true);

    const resultA = await controller.waitForRoleBasedRun(runA.id);
    expect(resultA.run.status).toBe("cancelled");

    const resultB = await controller.waitForRoleBasedRun(runB.id);
    expect(resultB.run.status).toBe("completed");
    expect(runBCompleted).toBe(true);
  });

  it("exact active participant cancellation: aborts active turn, marks participant cancelled, run failed, no retry", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let nextCallCount = 0;
    let turnStartedResolve: () => void;
    const turnStarted = new Promise<void>(resolve => { turnStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test active participant cancellation",
      budget: { maxRetriesPerParticipant: 3 },
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        id: "architect",
        onNext: async (_, ctx) => {
          nextCallCount++;
          turnStartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Turn cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    const architectParticipantId = prepared.plans.find(p => p.roleId === "architect")!.participantId;

    await turnStarted;

    const cancelled = await controller.cancelRoleParticipant(run.id, architectParticipantId);
    expect(cancelled).toBe(true);

    const result = await controller.waitForRoleBasedRun(run.id);

    // No retries attempted despite maxRetriesPerParticipant: 3
    expect(nextCallCount).toBe(1);
    expect(result.run.status).toBe("failed");
    expect(result.run.finalSummary).toContain(architectParticipantId);
    expect(result.run.participantsById[architectParticipantId]?.status).toBe("cancelled");
    expect(result.turns.length).toBe(1);
    expect(result.turns[0]?.status).toBe("cancelled");
  });

  it("exact idle participant cancellation: fail-closed for required workflow", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let architectTurnStartedResolve: () => void;
    const architectTurnStarted = new Promise<void>(resolve => { architectTurnStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test idle participant cancellation",
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        id: "architect",
        onNext: async (_, ctx) => {
          architectTurnStartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    const implementerParticipantId = prepared.plans.find(p => p.roleId === "implementer")!.participantId;

    await architectTurnStarted;

    // Cancel the IDLE implementer while architect is running
    const cancelled = await controller.cancelRoleParticipant(run.id, implementerParticipantId);
    expect(cancelled).toBe(true);

    const result = await controller.waitForRoleBasedRun(run.id);
    expect(result.run.status).toBe("failed");
    expect(result.run.finalSummary).toContain(implementerParticipantId);
    expect(result.run.participantsById[implementerParticipantId]?.status).toBe("cancelled");
  });

  it("cross-run participant rejection: cannot cancel participant from Run A using Run B", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    const configA: CollaborationConfig = {
      objective: "A",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };
    const configB: CollaborationConfig = {
      objective: "B",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    let runAStartedResolve: () => void;
    const runAStarted = new Promise<void>(resolve => { runAStartedResolve = resolve; });
    let runBStartedResolve: () => void;
    const runBStarted = new Promise<void>(resolve => { runBStartedResolve = resolve; });

    const preparedA = buildPrepared(configA, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          runAStartedResolve();
          return new Promise<AgentDecision>((_, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      }),
    });
    const preparedB = buildPrepared(configB, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          runBStartedResolve();
          return new Promise<AgentDecision>((_, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      }),
    });

    const runA = await controller.startRoleBasedRun("ses_test", configA, preparedA);
    const runB = await controller.startRoleBasedRun("ses_test", configB, preparedB);

    await Promise.all([runAStarted, runBStarted]);

    const partAId = preparedA.plans[0]!.participantId;

    await expect(controller.cancelRoleParticipant(runB.id, partAId)).rejects.toThrow(
      /does not belong to run/,
    );

    // Clean up active runs
    await controller.cancelRoleBasedRun(runA.id);
    await controller.cancelRoleBasedRun(runB.id);
  });

  it("proof that P4 cancellation NEVER calls sessionManager.cancel()", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let turnStartedResolve: () => void;
    const turnStarted = new Promise<void>(resolve => { turnStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test sessionManager isolation",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          turnStartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    await turnStarted;

    await controller.cancelRoleBasedRun(run.id);

    // Legacy cancel calls sessionManager.cancel(), but P4 MUST NOT!
    expect(sessionManager.cancelCallCount).toBe(0);
  });

  it("cancellation idempotency: repeated cancellation returns false and causes no secondary errors", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let turnStartedResolve: () => void;
    const turnStarted = new Promise<void>(resolve => { turnStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test idempotency",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          turnStartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    await turnStarted;

    const firstCancel = await controller.cancelRoleBasedRun(run.id);
    expect(firstCancel).toBe(true);

    const secondCancel = await controller.cancelRoleBasedRun(run.id);
    expect(secondCancel).toBe(false);
  });

  it("same-participant retry: transient decision error retries same adapter and resets consecutiveFailures on success", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let nextAttempts = 0;
    const adapter = new TrackedMockAdapter({
      id: "architect",
      onNext: async () => {
        nextAttempts++;
        if (nextAttempts === 1) {
          return { type: "error", message: "Transient rate limit", retryable: true };
        }
        return { type: "done", summary: "Design completed after retry" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test retry on error decision",
      budget: { maxRetriesPerParticipant: 2 },
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(nextAttempts).toBe(2);
    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("Design completed after retry");
    const partId = prepared.plans[0]!.participantId;
    expect(result.run.participantsById[partId]?.consecutiveFailures).toBe(0);
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]?.status).toBe("failed");
    expect(result.turns[0]?.turnIndex).toBe(0);
    expect(result.turns[1]?.status).toBe("completed");
    expect(result.turns[1]?.turnIndex).toBe(1);
  });

  it("same-participant retry: thrown operational error closes failed adapter, recreates via factory, and succeeds", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let adapter1Closed = false;
    let adapter2Initialized = false;

    const adapter1 = new TrackedMockAdapter({
      id: "architect-1",
      onNext: async () => {
        throw new BridgeError("agent_adapter_failed", "Process crash", true);
      },
      onClose: () => {
        adapter1Closed = true;
      },
    });

    const adapter2 = new TrackedMockAdapter({
      id: "architect-2",
      onInitialize: () => {
        adapter2Initialized = true;
      },
      onNext: async () => {
        return { type: "done", summary: "Succeeded on recreated adapter" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test operational error recreation",
      budget: { maxRetriesPerParticipant: 2 },
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(
      config,
      registry,
      { architect: adapter1 },
      { architect: () => adapter2 },
    );

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(adapter1Closed).toBe(true);
    expect(adapter2Initialized).toBe(true);
    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("Succeeded on recreated adapter");
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]?.status).toBe("failed");
    expect(result.turns[0]?.turnIndex).toBe(0);
    expect(result.turns[1]?.status).toBe("completed");
    expect(result.turns[1]?.turnIndex).toBe(1);
  });

  it("retry exhaustion: fails run when failures exceed maxRetriesPerParticipant", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let attempts = 0;
    const adapter = new TrackedMockAdapter({
      id: "architect",
      onNext: async () => {
        attempts++;
        return { type: "error", message: `Failure #${attempts}`, retryable: true };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test retry exhaustion",
      budget: { maxRetriesPerParticipant: 2 }, // Initial + 2 retries = 3 attempts max
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(attempts).toBe(3);
    expect(result.run.status).toBe("failed");
    expect(result.run.finalSummary).toBe("Failure #3");
    expect(result.turns.length).toBe(3);
    expect(result.turns[0]?.turnIndex).toBe(0);
    expect(result.turns[1]?.turnIndex).toBe(1);
    expect(result.turns[2]?.turnIndex).toBe(2);
  });

  it("non-retryable error: fails run immediately on first attempt without retrying", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let attempts = 0;
    const adapter = new TrackedMockAdapter({
      id: "architect",
      onNext: async () => {
        attempts++;
        return { type: "error", message: "Fatal syntax error", retryable: false };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test non-retryable error",
      budget: { maxRetriesPerParticipant: 5 },
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(attempts).toBe(1);
    expect(result.run.status).toBe("failed");
    expect(result.run.finalSummary).toBe("Fatal syntax error");
    expect(result.turns.length).toBe(1);
  });

  it("global maxTurns precedence over participant retries: stops with budget_exhausted", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let attempts = 0;
    const adapter = new TrackedMockAdapter({
      id: "architect",
      onNext: async () => {
        attempts++;
        return { type: "error", message: `Retryable error ${attempts}`, retryable: true };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test maxTurns precedence",
      budget: {
        maxTurns: 2,
        maxRetriesPerParticipant: 5,
      },
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });

    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    // Initial attempt consumes turn 0, retry 1 consumes turn 1. At turnIndex 2 >= maxTurns (2), loop halts!
    expect(attempts).toBe(2);
    expect(result.run.status).toBe("budget_exhausted");
    expect(result.run.finalSummary).toContain("Exceeded maximum allowed turns");
    expect(result.turns.length).toBe(2);
  });

  it("SQLite persistence integrity: each failed attempt is durably recorded with unique turn_index", async () => {
    closeDatabase();

    try {
      const db = initDatabase(":memory:");
      db.exec(`
        INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
        VALUES ('ses_sqlite_test', 'chatgpt-web', 'gpt-4', 'active', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');
      `);
      const persistence = new SqliteCollaborationPersistence();
      const sessionManager = new FakeSessionManager();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      let attempts = 0;
      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: async () => {
          attempts++;
          if (attempts === 1) {
            return { type: "error", message: "Transient DB lock", retryable: true };
          }
          return { type: "done", summary: "Success on second try" };
        },
      });

      const config: CollaborationConfig = {
        objective: "Test SQLite retry persistence",
        budget: { maxRetriesPerParticipant: 2 },
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });

      const result = await controller.executeRoleBasedRun("ses_sqlite_test", config, prepared);

      expect(result.run.status).toBe("completed");

      // Verify directly from SQLite
      const persistedRun = persistence.getRun(result.run.id);
      expect(persistedRun).not.toBeNull();
      expect(persistedRun!.status).toBe("completed");

      const transcript = persistence.getTranscript(result.run.id);
      // Both the retryable error decision message and the done decision message must be in transcript
      expect(transcript.length).toBe(2);
      expect(transcript[0]?.decisionType).toBe("error");
      expect(transcript[0]?.content).toBe("Transient DB lock");
      expect(transcript[1]?.decisionType).toBe("done");
      expect(transcript[1]?.content).toBe("Success on second try");
    } finally {
      closeDatabase();
    }
  });

  it("cancelAllRoleBasedRuns cancels all active P4 runs cleanly", async () => {
    const sessionManager = new FakeSessionManager();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      new InMemoryRoleBasedRunPersistence(),
    );

    let run1StartedResolve: () => void;
    const run1Started = new Promise<void>(resolve => { run1StartedResolve = resolve; });

    let run2StartedResolve: () => void;
    const run2Started = new Promise<void>(resolve => { run2StartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test cancelAll",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared1 = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          run1StartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const prepared2 = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          run2StartedResolve();
          return new Promise<AgentDecision>((resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const run1 = await controller.startRoleBasedRun("ses_test", config, prepared1);
    const run2 = await controller.startRoleBasedRun("ses_test", config, prepared2);

    await Promise.all([run1Started, run2Started]);

    const count = await controller.cancelAllRoleBasedRuns();
    expect(count).toBe(2);

    const [res1, res2] = await Promise.all([
      controller.waitForRoleBasedRun(run1.id),
      controller.waitForRoleBasedRun(run2.id),
    ]);

    expect(res1.run.status).toBe("cancelled");
    expect(res2.run.status).toBe("cancelled");
  });

  it("blocker #4: whole-run cancellation leaves pending participants pending, active participant cancelled", async () => {
    const sessionManager = new FakeSessionManager();
    const persistence = new InMemoryRoleBasedRunPersistence();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      persistence,
    );

    let architectStartedResolve: () => void;
    const architectStarted = new Promise<void>(resolve => { architectStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test pending participant preservation on run cancel",
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
        reviewer: { adapterType: "acp:claude" },
      },
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        terminalRoles: ["reviewer"],
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          architectStartedResolve();
          return new Promise<AgentDecision>((_, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    const archPartId = prepared.plans.find(p => p.roleId === "architect")!.participantId;
    const implPartId = prepared.plans.find(p => p.roleId === "implementer")!.participantId;
    const revPartId = prepared.plans.find(p => p.roleId === "reviewer")!.participantId;

    await architectStarted;
    await controller.cancelRoleBasedRun(run.id);

    const result = await controller.waitForRoleBasedRun(run.id);
    expect(result.run.status).toBe("cancelled");
    expect(result.run.activeParticipantId).toBeUndefined();

    // Active participant became cancelled
    expect(result.run.participantsById[archPartId]?.status).toBe("cancelled");
    // Subsequent participants remained pending (never activated)
    expect(result.run.participantsById[implPartId]?.status).toBe("pending");
    expect(result.run.participantsById[revPartId]?.status).toBe("pending");

    // The active turn was cancelled
    expect(result.turns.length).toBe(1);
    expect(result.turns[0]?.status).toBe("cancelled");
  });

  it("blocker #5: cancelling required idle participant marks target cancelled, active participant idle", async () => {
    const sessionManager = new FakeSessionManager();
    const persistence = new InMemoryRoleBasedRunPersistence();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      persistence,
    );

    let architectStartedResolve: () => void;
    const architectStarted = new Promise<void>(resolve => { architectStartedResolve = resolve; });

    const config: CollaborationConfig = {
      objective: "Test active transition to idle on non-active cancel",
      roles: {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      },
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
    };

    const prepared = buildPrepared(config, registry, {
      architect: new TrackedMockAdapter({
        onNext: async (_, ctx) => {
          architectStartedResolve();
          return new Promise<AgentDecision>((_, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              reject(new DOMException("Interrupted", "AbortError"));
            });
          });
        },
      }),
    });

    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    const archPartId = prepared.plans.find(p => p.roleId === "architect")!.participantId;
    const implPartId = prepared.plans.find(p => p.roleId === "implementer")!.participantId;

    await architectStarted;
    // Cancel the IDLE implementer while architect is active
    await controller.cancelRoleParticipant(run.id, implPartId);

    const result = await controller.waitForRoleBasedRun(run.id);
    expect(result.run.status).toBe("failed");
    expect(result.run.activeParticipantId).toBeUndefined();

    // Target participant marked cancelled
    expect(result.run.participantsById[implPartId]?.status).toBe("cancelled");
    // Interrupted active participant reset to idle (NOT cancelled or active)
    expect(result.run.participantsById[archPartId]?.status).toBe("idle");
  });

  it("blocker #6: turnsExecuted only increments on successful completed turns (message, done, pause)", async () => {
    const sessionManager = new FakeSessionManager();
    const persistence = new InMemoryRoleBasedRunPersistence();
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
      persistence,
    );

    let attempts = 0;
    const adapter = new TrackedMockAdapter({
      id: "architect",
      onNext: async () => {
        attempts++;
        if (attempts === 1) {
          // Attempt 1: retryable error decision - MUST NOT increment turnsExecuted
          return { type: "error", message: "Transient glitch", retryable: true };
        }
        // Attempt 2: done decision - MUST increment turnsExecuted
        return { type: "done", summary: "Finished design" };
      },
    });

    const config: CollaborationConfig = {
      objective: "Test turnsExecuted invariant",
      budget: { maxRetriesPerParticipant: 2 },
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });
    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("completed");
    const partId = prepared.plans[0]!.participantId;
    // Despite 2 turn records (1 failed, 1 completed), turnsExecuted MUST be exactly 1!
    expect(result.turns).toHaveLength(2);
    expect(result.run.participantsById[partId]?.turnsExecuted).toBe(1);
  });

  it("blocker #7: paused is non-terminal / resumable; completedAt remains undefined", async () => {
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
      onNext: () => ({ type: "pause", reason: "Awaiting human-in-the-loop review" }),
    });

    const config: CollaborationConfig = {
      objective: "Test pause behavior",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });
    const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

    expect(result.run.status).toBe("paused");
    expect(result.run.finalSummary).toBe("Awaiting human-in-the-loop review");
    expect(result.run.completedAt).toBeUndefined();
    expect(result.run.activeParticipantId).toBeUndefined();
    const partId = prepared.plans[0]!.participantId;
    expect(result.run.participantsById[partId]?.status).toBe("idle");
    expect(result.run.participantsById[partId]?.turnsExecuted).toBe(1);
  });

  it("blocker #8: missing rolePersistence on RunController throws role_persistence_unavailable", async () => {
    const sessionManager = new FakeSessionManager();
    // Intentionally omit rolePersistence
    const controller = new RunController(
      new FakeRunStore() as any,
      sessionManager as any,
      new FakeAuditStore() as any,
      () => { throw new Error("not called"); },
    );

    const config: CollaborationConfig = {
      objective: "Test persistence requirement",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };
    const prepared = buildPrepared(config, registry, {});

    try {
      await controller.startRoleBasedRun("ses_test", config, prepared);
      expect.unreachable("startRoleBasedRun should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe("role_persistence_unavailable");
    }

    try {
      await controller.executeRoleBasedRun("ses_test", config, prepared);
      expect.unreachable("executeRoleBasedRun should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe("role_persistence_unavailable");
    }
  });

  it("blocker #9: cannot cancel an already completed run; returns false and leaves status intact", async () => {
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
      onNext: () => ({ type: "done", summary: "Instant complete" }),
    });

    const config: CollaborationConfig = {
      objective: "Test cancel completed",
      roles: { architect: { adapterType: "acp:claude" } },
      policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
    };

    const prepared = buildPrepared(config, registry, { architect: adapter });
    const run = await controller.startRoleBasedRun("ses_test", config, prepared);
    const result = await controller.waitForRoleBasedRun(run.id);

    expect(result.run.status).toBe("completed");

    // Attempt to cancel already-completed run
    const cancelResult = await controller.cancelRoleBasedRun(run.id);
    expect(cancelResult).toBe(false);

    // Status remains completed
    const finalRun = persistence.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
  });

  describe("P4.5.2 Cancellation Race, Structured Reasons & Persistence Failure Propagation", () => {
    it("cancellation wins race: cancel returns true and run ends as cancelled", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      let adapterAborted = false;
      let releaseAdapter: () => void = () => {};
      const adapterPromise = new Promise<void>((resolve) => {
        releaseAdapter = resolve;
      });

      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: async (_input, ctx) => {
          ctx.signal?.addEventListener("abort", () => {
            adapterAborted = true;
            releaseAdapter();
          });
          await adapterPromise;
          if (ctx.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          return { type: "done", summary: "Completed late" };
        },
      });

      const config: CollaborationConfig = {
        objective: "Test cancel wins race",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      while (adapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const cancelSuccess = await controller.cancelRoleBasedRun(run.id, "Emergency operator cancel");
      expect(cancelSuccess).toBe(true);

      const canonicalRun = persistence.getRun(run.id);
      expect(canonicalRun?.status).toBe("cancelled");
      expect(canonicalRun?.finalSummary).toBe("Emergency operator cancel");
      expect(adapterAborted).toBe(true);
      expect(adapter.closed).toBe(true);
    });

    it("completion wins cancellation race: cancel returns false and terminal completion is never overwritten", async () => {
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
        id: "reviewer",
        onNext: () => {
          return { type: "done", summary: "Review approved and signed off" };
        },
      });

      const config: CollaborationConfig = {
        objective: "Test completion wins race",
        roles: { reviewer: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["reviewer"], loopMode: "once", terminalRoles: ["reviewer"] },
      };

      const prepared = buildPrepared(config, registry, { reviewer: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      const settled = await controller.waitForRoleBasedRun(run.id);
      expect(settled.run.status).toBe("completed");
      expect(settled.run.finalSummary).toBe("Review approved and signed off");

      const cancelSuccess = await controller.cancelRoleBasedRun(run.id, "Racing cancel attempt");
      expect(cancelSuccess).toBe(false);

      const canonicalRun = persistence.getRun(run.id);
      expect(canonicalRun?.status).toBe("completed");
      expect(canonicalRun?.finalSummary).toBe("Review approved and signed off");
    });

    it("custom cancellation reasons are strictly preserved in finalSummary", async () => {
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
        onNext: async (_input, ctx) => {
          await new Promise((r) => {
            ctx.signal?.addEventListener("abort", r);
          });
          throw new DOMException("Aborted", "AbortError");
        },
      });

      const config: CollaborationConfig = {
        objective: "Test custom reason preservation",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      while (adapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const cancelSuccess = await controller.cancelRoleBasedRun(run.id, "Operator requested shutdown");
      expect(cancelSuccess).toBe(true);

      const canonicalRun = persistence.getRun(run.id);
      expect(canonicalRun?.status).toBe("cancelled");
      expect(canonicalRun?.finalSummary).toBe("Operator requested shutdown");
    });

    it("participant cancellation reason preserves participant identity and reason in finalSummary", async () => {
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
        onNext: async (_input, ctx) => {
          await new Promise((r) => {
            ctx.signal?.addEventListener("abort", r);
          });
          throw new DOMException("Aborted", "AbortError");
        },
      });

      const config: CollaborationConfig = {
        objective: "Test participant reason preservation",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);
      const targetPartId = prepared.plans[0]!.participantId;

      while (adapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const cancelSuccess = await controller.cancelRoleParticipant(
        run.id,
        targetPartId,
        "Participant exceeded operator policy",
      );
      expect(cancelSuccess).toBe(true);

      const canonicalRun = persistence.getRun(run.id);
      expect(canonicalRun?.status).toBe("failed");
      expect(canonicalRun?.finalSummary).toBe(
        `Required participant '${targetPartId}' was cancelled: Participant exceeded operator policy`,
      );
    });

    it("oversized cancellation reason (> 8 KiB) is rejected with invalid_request", async () => {
      const sessionManager = new FakeSessionManager();
      const persistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        persistence,
      );

      const config: CollaborationConfig = {
        objective: "Test oversized reason",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };
      const prepared = buildPrepared(config, registry, {});
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);
      const partId = prepared.plans[0]!.participantId;

      const oversized = "A".repeat(MAX_CANCELLATION_REASON_BYTES + 100);

      expect(controller.cancelRoleBasedRun(run.id, oversized)).rejects.toThrow(
        expect.objectContaining({ code: "invalid_request" }),
      );

      expect(controller.cancelRoleParticipant(run.id, partId, oversized)).rejects.toThrow(
        expect.objectContaining({ code: "invalid_request" }),
      );
    });

    it("settlement persistence failure propagates through cancelRoleBasedRun without being swallowed", async () => {
      const sessionManager = new FakeSessionManager();
      const failingPersistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        failingPersistence,
      );

      const adapter = new TrackedMockAdapter({
        id: "architect",
        onNext: async (_input, ctx) => {
          await new Promise((r) => {
            ctx.signal?.addEventListener("abort", r);
          });
          throw new DOMException("Aborted", "AbortError");
        },
      });

      const config: CollaborationConfig = {
        objective: "Test settlement persistence failure",
        roles: { architect: { adapterType: "acp:claude" } },
        policy: { roleSequence: ["architect"], loopMode: "once", terminalRoles: ["architect"] },
      };

      const prepared = buildPrepared(config, registry, { architect: adapter });
      const run = await controller.startRoleBasedRun("ses_test", config, prepared);

      while (adapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      failingPersistence.recordTurnTransaction = () => {
        throw new Error("Disk I/O error during cancelled turn commit");
      };

      try {
        await controller.cancelRoleBasedRun(run.id, "Cancel attempt");
        expect.unreachable("cancelRoleBasedRun should have thrown on persistence failure");
      } catch (err: any) {
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.code).toBe("collaboration_persistence_failed");
        expect(err.message).toContain("Disk I/O error during cancelled turn commit");
      }

      expect(adapter.closed).toBe(true);
    });

    it("non-active participant persistence failure still aborts active runtime and closes adapters", async () => {
      const sessionManager = new FakeSessionManager();
      const failingPersistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        failingPersistence,
      );

      let architectSignalAborted = false;
      const architectAdapter = new TrackedMockAdapter({
        id: "architect",
        onNext: async (_input, ctx) => {
          ctx.signal?.addEventListener("abort", () => {
            architectSignalAborted = true;
          });
          await new Promise((r) => {
            ctx.signal?.addEventListener("abort", r);
          });
          throw new DOMException("Aborted", "AbortError");
        },
      });

      const implementerAdapter = new TrackedMockAdapter({ id: "implementer" });

      const config: CollaborationConfig = {
        objective: "Test non-active participant cancel failure teardown",
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "subprocess-jsonl" },
        },
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
      };

      const prepared = buildPrepared(config, registry, {
        architect: architectAdapter,
        implementer: implementerAdapter,
      });

      const run = await controller.startRoleBasedRun("ses_test", config, prepared);
      const implementerPartId = prepared.plans[1]!.participantId;

      while (architectAdapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      failingPersistence.updateParticipantAndRunTransaction = () => {
        throw new Error("Disk full while recording non-active participant cancellation");
      };

      try {
        await controller.cancelRoleParticipant(run.id, implementerPartId, "Cancel implementer");
        expect.unreachable("cancelRoleParticipant should have thrown on persistence failure");
      } catch (err: any) {
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.code).toBe("collaboration_persistence_failed");
      }

      expect(architectSignalAborted).toBe(true);
      expect(architectAdapter.closed).toBe(true);
      expect(implementerAdapter.nextCalls).toBe(0);
    });

    it("active participant cancellation persistence failure propagates and closes adapter", async () => {
      const sessionManager = new FakeSessionManager();
      const failingPersistence = new InMemoryRoleBasedRunPersistence();
      const controller = new RunController(
        new FakeRunStore() as any,
        sessionManager as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        failingPersistence,
      );

      const architectAdapter = new TrackedMockAdapter({
        id: "architect",
        onNext: async (_input, ctx) => {
          await new Promise((r) => {
            ctx.signal?.addEventListener("abort", r);
          });
          throw new DOMException("Aborted", "AbortError");
        },
      });

      const implementerAdapter = new TrackedMockAdapter({ id: "implementer" });

      const config: CollaborationConfig = {
        objective: "Test active participant cancel failure propagation",
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "subprocess-jsonl" },
        },
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
      };

      const prepared = buildPrepared(config, registry, {
        architect: architectAdapter,
        implementer: implementerAdapter,
      });

      const run = await controller.startRoleBasedRun("ses_test", config, prepared);
      const architectPartId = prepared.plans[0]!.participantId;

      while (architectAdapter.nextCalls === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      failingPersistence.recordTurnTransaction = () => {
        throw new Error("Disk corruption during active participant cancellation turn commit");
      };

      try {
        await controller.cancelRoleParticipant(run.id, architectPartId, "Cancel active architect");
        expect.unreachable("cancelRoleParticipant should have thrown on persistence failure");
      } catch (err: any) {
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.code).toBe("collaboration_persistence_failed");
      }

      expect(architectAdapter.closed).toBe(true);
      expect(implementerAdapter.nextCalls).toBe(0);
    });
  });
});
