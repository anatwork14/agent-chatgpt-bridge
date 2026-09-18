import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RunController } from "./run-controller";
import { RoleRegistry } from "./role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import {
  createInitialParticipantRecords,
  createParticipantAssignmentPlans,
} from "./participant-assignment";
import type { CollaborationConfig } from "./collaboration-domain";
import type {
  AgentDecision,
  AgentTurnInput,
  ExternalAgentAdapter,
} from "./domain";
import type {
  ParticipantRuntime,
  PreparedRoleParticipants,
} from "./collaboration-runtime";
import type { CollaborationDagDefinition } from "./collaboration-dag";
import { SqliteCollaborationDagPersistence } from "../persistence/sqlite-collaboration-dag-persistence";
import { closeDatabase, initDatabase } from "../persistence/database";

class FakeRunStore {
  create() {}
  get() { return null; }
  update() {}
  list() { return []; }
}

class FakeSessionManager {
  public cancelCalls = 0;
  async get(id: string) {
    return {
      id,
      status: "active",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
  }
  async cancel() {
    this.cancelCalls++;
    return true;
  }
}

class FakeAuditStore {
  readonly events: any[] = [];
  log(event: any) {
    this.events.push(event);
  }
}

class MockAdapter implements ExternalAgentAdapter {
  readonly id: string;
  initializeCalls = 0;
  nextCalls = 0;
  closeCalls = 0;
  readonly inputs: AgentTurnInput[] = [];

  constructor(
    id: string,
    private readonly behavior: (
      input: AgentTurnInput,
      ctx: { signal?: AbortSignal },
      call: number,
    ) => Promise<AgentDecision> | AgentDecision,
  ) {
    this.id = id;
  }

  async initialize(): Promise<void> {
    this.initializeCalls++;
  }

  async next(
    input: AgentTurnInput,
    ctx: { signal?: AbortSignal },
  ): Promise<AgentDecision> {
    this.nextCalls++;
    this.inputs.push(input);
    return await this.behavior(input, ctx, this.nextCalls);
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

const registry = new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);

function baseConfig(): CollaborationConfig {
  return {
    objective: "Design, critique, implement, and review a bounded DAG feature",
    policy: {
      roleSequence: ["architect", "critic", "implementer", "reviewer"],
      loopMode: "once",
      terminalRoles: ["reviewer"],
    },
    roles: {
      architect: { adapterType: "acp:claude" },
      critic: { adapterType: "acp:claude" },
      implementer: { adapterType: "acp:antigravity" },
      reviewer: { adapterType: "acp:claude" },
    },
  };
}

function prepare(
  config: CollaborationConfig,
  adaptersByRole: Record<string, MockAdapter>,
): {
  prepared: PreparedRoleParticipants;
  byRole: Record<string, string>;
} {
  const ids = ["part_arch", "part_critic", "part_impl", "part_review"];
  let index = 0;
  const plans = createParticipantAssignmentPlans(config, registry, {
    idFactory: () => ids[index++]!,
  });
  const records = createInitialParticipantRecords(plans, {
    clock: () => "2026-09-18T00:00:00.000Z",
  });
  const runtimes: ParticipantRuntime[] = plans.map(plan => ({
    participantId: plan.participantId,
    roleId: plan.roleId,
    adapterId: plan.adapterId,
    adapter: adaptersByRole[plan.roleId]!,
  }));
  return {
    prepared: { plans, records, runtimes },
    byRole: Object.fromEntries(plans.map(plan => [plan.roleId, plan.participantId])),
  };
}

function dag(byRole: Record<string, string>): CollaborationDagDefinition {
  return {
    version: 1,
    nodes: [
      {
        id: "architecture",
        participantId: byRole.architect!,
        instruction: "Create the architecture",
        dependsOn: [],
      },
      {
        id: "critique",
        participantId: byRole.critic!,
        instruction: "Critique the architecture",
        dependsOn: ["architecture"],
      },
      {
        id: "implementation",
        participantId: byRole.implementer!,
        instruction: "Produce an implementation",
        dependsOn: ["architecture"],
      },
      {
        id: "review",
        participantId: byRole.reviewer!,
        instruction: "Synthesize critique and implementation",
        dependsOn: ["critique", "implementation"],
        terminal: true,
      },
    ],
  };
}

function controller(
  persistence: SqliteCollaborationDagPersistence,
  sessions = new FakeSessionManager(),
  audit = new FakeAuditStore(),
): { controller: RunController; sessions: FakeSessionManager; audit: FakeAuditStore } {
  return {
    controller: new RunController(
      new FakeRunStore() as any,
      sessions as any,
      audit as any,
      () => { throw new Error("legacy adapter factory must not be used by P5"); },
      undefined,
      undefined,
      persistence,
    ),
    sessions,
    audit,
  };
}

beforeEach(() => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.exec(`
    INSERT INTO sessions (id, provider, model, status, created_at, updated_at)
    VALUES (
      'ses_p5_controller', 'chatgpt-web', 'high', 'ready',
      '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z'
    );
  `);
});

afterEach(() => {
  closeDatabase();
});

describe("P5 RunController DAG orchestration", () => {
  it("runs fan-out branches concurrently and feeds deterministic persisted fan-in to reviewer", async () => {
    let branchActive = 0;
    let maxBranchActive = 0;

    const architect = new MockAdapter("architect", () => ({
      type: "message",
      content: "ARCH",
    }));
    const critic = new MockAdapter("critic", async () => {
      branchActive++;
      maxBranchActive = Math.max(maxBranchActive, branchActive);
      await new Promise(resolve => setTimeout(resolve, 25));
      branchActive--;
      return { type: "message", content: "CRITIQUE" };
    });
    const implementer = new MockAdapter("implementer", async () => {
      branchActive++;
      maxBranchActive = Math.max(maxBranchActive, branchActive);
      await new Promise(resolve => setTimeout(resolve, 15));
      branchActive--;
      return { type: "message", content: "IMPLEMENTATION" };
    });
    const reviewer = new MockAdapter("reviewer", input => {
      expect(input.collaboration?.dag?.nodeId).toBe("review");
      expect(input.collaboration?.dag?.instruction).toBe("Synthesize critique and implementation");
      expect(input.collaboration?.dag?.dependencyNodeIds).toEqual([
        "critique",
        "implementation",
      ]);
      expect(input.collaboration?.priorTurns.map(turn => turn.text)).toEqual([
        "CRITIQUE",
        "IMPLEMENTATION",
      ]);
      return { type: "done", summary: "REVIEW_OK" };
    });

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });
    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController, audit } = controller(persistence);

    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      dag(byRole),
      {
        budget: {
          maxParallelTurns: 2,
          maxTurns: 12,
          maxRetriesPerParticipant: 1,
        },
      },
    );

    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("REVIEW_OK");
    expect(result.nodes.every(node => node.status === "completed")).toBe(true);
    expect(maxBranchActive).toBe(2);

    const messages = persistence.getMessagesByNode(result.run.id);
    expect(messages.architecture?.content).toBe("ARCH");
    expect(messages.critique?.content).toBe("CRITIQUE");
    expect(messages.implementation?.content).toBe("IMPLEMENTATION");
    expect(messages.review?.content).toBe("REVIEW_OK");

    const startedEvents = audit.events.filter(
      event => event.eventType === "collaboration.dag.node.started",
    );
    expect(startedEvents.map(event => event.payload.nodeId)).toEqual([
      "architecture",
      "critique",
      "implementation",
      "review",
    ]);
    expect(JSON.stringify(audit.events)).not.toContain("CRITIQUE");
    expect(JSON.stringify(audit.events)).not.toContain("IMPLEMENTATION");
  });

  it("serializes two ready nodes bound to the same participant even with spare global capacity", async () => {
    let criticActive = 0;
    let maxCriticActive = 0;
    const criticCalls: string[] = [];

    const architect = new MockAdapter("architect", () => ({ type: "message", content: "ARCH" }));
    const critic = new MockAdapter("critic", async input => {
      criticActive++;
      maxCriticActive = Math.max(maxCriticActive, criticActive);
      criticCalls.push(input.collaboration?.dag?.nodeId ?? "missing");
      await new Promise(resolve => setTimeout(resolve, 10));
      criticActive--;
      return { type: "message", content: input.collaboration?.dag?.nodeId ?? "critic" };
    });
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "IMPL" }));
    const reviewer = new MockAdapter("reviewer", () => ({ type: "done", summary: "DONE" }));

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });

    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "root",
          participantId: byRole.architect!,
          instruction: "root",
          dependsOn: [],
        },
        {
          id: "critic_a",
          participantId: byRole.critic!,
          instruction: "a",
          dependsOn: ["root"],
        },
        {
          id: "critic_b",
          participantId: byRole.critic!,
          instruction: "b",
          dependsOn: ["root"],
        },
        {
          id: "review",
          participantId: byRole.reviewer!,
          instruction: "review",
          dependsOn: ["critic_a", "critic_b"],
          terminal: true,
        },
      ],
    };

    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController } = controller(persistence);
    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      graph,
      { budget: { maxParallelTurns: 3 } },
    );

    expect(result.run.status).toBe("completed");
    expect(maxCriticActive).toBe(1);
    expect(criticCalls).toEqual(["critic_a", "critic_b"]);
  });

  it("retries on the same participant without provider rotation and persists both attempts", async () => {
    const architect = new MockAdapter("architect", (_input, _ctx, call) => {
      if (call === 1) {
        return { type: "error", message: "transient", retryable: true };
      }
      return { type: "message", content: "ARCH_AFTER_RETRY" };
    });
    const critic = new MockAdapter("critic", () => ({ type: "message", content: "CRIT" }));
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "IMPL" }));
    const reviewer = new MockAdapter("reviewer", () => ({ type: "done", summary: "DONE" }));

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });
    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController, audit } = controller(persistence);

    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      dag(byRole),
      {
        budget: {
          maxParallelTurns: 2,
          maxRetriesPerParticipant: 1,
          maxTurns: 12,
        },
      },
    );

    expect(result.run.status).toBe("completed");
    expect(architect.nextCalls).toBe(2);
    expect(result.nodes.find(node => node.id === "architecture")?.attempt).toBe(2);
    expect(persistence.getRun(result.run.id)?.turnHistory).toHaveLength(5);
    expect(
      audit.events.some(event => event.eventType === "collaboration.dag.node.retrying"),
    ).toBe(true);
  });

  it("cancels the exact DAG run and never calls SessionManager.cancel", async () => {
    let sawAbort = false;
    const architect = new MockAdapter("architect", (_input, { signal }) =>
      new Promise<AgentDecision>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      }),
    );
    const critic = new MockAdapter("critic", () => ({ type: "message", content: "CRIT" }));
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "IMPL" }));
    const reviewer = new MockAdapter("reviewer", () => ({ type: "done", summary: "DONE" }));

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });
    const persistence = new SqliteCollaborationDagPersistence();
    const sessions = new FakeSessionManager();
    const { controller: runController } = controller(persistence, sessions);

    const run = await runController.startDagRun(
      "ses_p5_controller",
      config,
      prepared,
      dag(byRole),
      { budget: { maxParallelTurns: 2 } },
    );

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await runController.cancelDagRun(run.id, "test cancellation")).toBe(true);
    const result = await runController.waitForDagRun(run.id);

    expect(result.run.status).toBe("cancelled");
    expect(sawAbort).toBe(true);
    expect(sessions.cancelCalls).toBe(0);
    expect(
      result.nodes.filter(node => node.status === "cancelled").length,
    ).toBeGreaterThan(0);
  });

  it("fails closed when a non-terminal node tries to end the graph", async () => {
    const architect = new MockAdapter("architect", () => ({
      type: "done",
      summary: "unauthorized",
    }));
    const critic = new MockAdapter("critic", () => ({ type: "message", content: "CRIT" }));
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "IMPL" }));
    const reviewer = new MockAdapter("reviewer", () => ({ type: "done", summary: "DONE" }));

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });
    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController } = controller(persistence);

    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      dag(byRole),
      { budget: { maxParallelTurns: 2 } },
    );

    expect(result.run.status).toBe("failed");
    expect(result.nodes.find(node => node.id === "architecture")?.status).toBe("failed");
    expect(
      result.nodes
        .filter(node => node.id !== "architecture")
        .every(node => node.status === "cancelled"),
    ).toBe(true);
    expect(critic.nextCalls).toBe(0);
    expect(implementer.nextCalls).toBe(0);
    expect(reviewer.nextCalls).toBe(0);
  });

  it("skip_dependents persists skipped descendants while an independent terminal path completes", async () => {
    const architect = new MockAdapter("architect", () => {
      throw new Error("architecture branch failed");
    });
    const critic = new MockAdapter("critic", () => ({ type: "message", content: "SHOULD_NOT_RUN" }));
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "INDEPENDENT" }));
    const reviewer = new MockAdapter("reviewer", async () => {
      await new Promise(resolve => setTimeout(resolve, 8));
      return { type: "done", summary: "INDEPENDENT_TERMINAL_OK" };
    });

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });

    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "failing_root",
          participantId: byRole.architect!,
          instruction: "fail",
          dependsOn: [],
        },
        {
          id: "skipped_child",
          participantId: byRole.critic!,
          instruction: "must be skipped",
          dependsOn: ["failing_root"],
        },
        {
          id: "independent_work",
          participantId: byRole.implementer!,
          instruction: "independent",
          dependsOn: [],
        },
        {
          id: "independent_terminal",
          participantId: byRole.reviewer!,
          instruction: "finish independently",
          dependsOn: ["independent_work"],
          terminal: true,
        },
      ],
    };

    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController, audit } = controller(persistence);
    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      graph,
      {
        failurePolicy: "skip_dependents",
        budget: { maxParallelTurns: 2, maxRetriesPerParticipant: 0 },
      },
    );

    expect(result.run.status).toBe("completed");
    expect(result.run.finalSummary).toBe("INDEPENDENT_TERMINAL_OK");
    expect(result.nodes.find(node => node.id === "failing_root")?.status).toBe("failed");
    expect(result.nodes.find(node => node.id === "skipped_child")?.status).toBe("skipped");
    expect(result.nodes.find(node => node.id === "independent_terminal")?.status).toBe("completed");
    expect(critic.nextCalls).toBe(0);
    expect(
      audit.events.some(
        event =>
          event.eventType === "collaboration.dag.node.skipped" &&
          event.payload.nodeId === "skipped_child",
      ),
    ).toBe(true);
  });

  it("skip_dependents fails the run when every declared terminal path becomes unreachable", async () => {
    const architect = new MockAdapter("architect", () => {
      throw new Error("root failed");
    });
    const critic = new MockAdapter("critic", () => ({ type: "message", content: "SHOULD_NOT_RUN" }));
    const implementer = new MockAdapter("implementer", () => ({ type: "message", content: "SHOULD_NOT_RUN" }));
    const reviewer = new MockAdapter("reviewer", () => ({ type: "done", summary: "SHOULD_NOT_RUN" }));

    const config = baseConfig();
    const { prepared, byRole } = prepare(config, {
      architect,
      critic,
      implementer,
      reviewer,
    });

    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "root",
          participantId: byRole.architect!,
          instruction: "root",
          dependsOn: [],
        },
        {
          id: "critic_path",
          participantId: byRole.critic!,
          instruction: "critic",
          dependsOn: ["root"],
        },
        {
          id: "implementer_path",
          participantId: byRole.implementer!,
          instruction: "impl",
          dependsOn: ["root"],
        },
        {
          id: "terminal",
          participantId: byRole.reviewer!,
          instruction: "terminal",
          dependsOn: ["critic_path", "implementer_path"],
          terminal: true,
        },
      ],
    };

    const persistence = new SqliteCollaborationDagPersistence();
    const { controller: runController, audit } = controller(persistence);
    const result = await runController.executeDagRun(
      "ses_p5_controller",
      config,
      prepared,
      graph,
      {
        failurePolicy: "skip_dependents",
        budget: { maxParallelTurns: 2, maxRetriesPerParticipant: 0 },
      },
    );

    expect(result.run.status).toBe("failed");
    expect(result.nodes.find(node => node.id === "root")?.status).toBe("failed");
    expect(result.nodes.find(node => node.id === "critic_path")?.status).toBe("skipped");
    expect(result.nodes.find(node => node.id === "implementer_path")?.status).toBe("skipped");
    expect(result.nodes.find(node => node.id === "terminal")?.status).toBe("skipped");
    expect(critic.nextCalls).toBe(0);
    expect(implementer.nextCalls).toBe(0);
    expect(reviewer.nextCalls).toBe(0);
    expect(
      audit.events.filter(event => event.eventType === "collaboration.dag.node.skipped"),
    ).toHaveLength(3);
    expect(
      audit.events.some(event => event.eventType === "collaboration.dag.failed"),
    ).toBe(true);
  });

});
