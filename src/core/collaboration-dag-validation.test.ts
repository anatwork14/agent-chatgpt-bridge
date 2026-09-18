import { describe, expect, it } from "bun:test";
import {
  P5_DEFAULT_BUDGET,
  P5_LIMITS,
  isCollaborationDagNodeTerminalStatus,
  type CollaborationDagDefinition,
} from "./collaboration-dag";
import {
  CollaborationDagValidationError,
  isValidCollaborationDagNodeId,
  planCollaborationDag,
  validateCollaborationDagBudget,
  validateCollaborationDagDefinition,
} from "./collaboration-dag-validation";

const participants = new Set(["part_arch", "part_critic", "part_impl", "part_review"]);

function validGraph(): CollaborationDagDefinition {
  return {
    version: 1,
    nodes: [
      {
        id: "architecture",
        participantId: "part_arch",
        instruction: "Produce architecture plan",
        dependsOn: [],
      },
      {
        id: "critique",
        participantId: "part_critic",
        instruction: "Independently critique the architecture",
        dependsOn: ["architecture"],
      },
      {
        id: "implementation",
        participantId: "part_impl",
        instruction: "Produce implementation proposal",
        dependsOn: ["architecture"],
      },
      {
        id: "review",
        participantId: "part_review",
        instruction: "Synthesize and review both branches",
        dependsOn: ["critique", "implementation"],
        terminal: true,
      },
    ],
  };
}

describe("P5 collaboration DAG domain and validation", () => {
  it("accepts bounded node ids and rejects unsafe ids", () => {
    expect(isValidCollaborationDagNodeId("architecture")).toBe(true);
    expect(isValidCollaborationDagNodeId("review_2")).toBe(true);
    expect(isValidCollaborationDagNodeId("a".repeat(64))).toBe(true);
    expect(isValidCollaborationDagNodeId("Review")).toBe(false);
    expect(isValidCollaborationDagNodeId("../review")).toBe(false);
    expect(isValidCollaborationDagNodeId("a".repeat(65))).toBe(false);
  });

  it("recognizes immutable terminal node statuses", () => {
    for (const status of ["completed", "failed", "skipped", "cancelled"] as const) {
      expect(isCollaborationDagNodeTerminalStatus(status)).toBe(true);
    }
    for (const status of ["pending", "ready", "running"] as const) {
      expect(isCollaborationDagNodeTerminalStatus(status)).toBe(false);
    }
  });

  it("accepts P5 default budget and bounded parallelism greater than one", () => {
    expect(validateCollaborationDagBudget(P5_DEFAULT_BUDGET)).toEqual([]);
    expect(validateCollaborationDagBudget({ ...P5_DEFAULT_BUDGET, maxParallelTurns: 4 })).toEqual([]);
  });

  it("rejects zero and excessive parallelism", () => {
    expect(
      validateCollaborationDagBudget({ ...P5_DEFAULT_BUDGET, maxParallelTurns: 0 })
        .some(issue => issue.code === "invalid_parallelism"),
    ).toBe(true);
    expect(
      validateCollaborationDagBudget({
        ...P5_DEFAULT_BUDGET,
        maxParallelTurns: P5_LIMITS.maxParallelTurns + 1,
      }).some(issue => issue.code === "parallelism_limit_exceeded"),
    ).toBe(true);
  });

  it("validates a static fan-out/fan-in graph", () => {
    expect(
      validateCollaborationDagDefinition(validGraph(), {
        knownParticipantIds: participants,
        budget: P5_DEFAULT_BUDGET,
      }),
    ).toEqual([]);
  });

  it("rejects unknown participant bindings before execution", () => {
    const graph = validGraph();
    const mutated: CollaborationDagDefinition = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === "critique" ? { ...node, participantId: "part_missing" } : node,
      ),
    };
    expect(
      validateCollaborationDagDefinition(mutated, {
        knownParticipantIds: participants,
        budget: P5_DEFAULT_BUDGET,
      }).some(issue => issue.code === "unknown_participant"),
    ).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const graph = validGraph();
    const mutated: CollaborationDagDefinition = {
      version: 1,
      nodes: [...graph.nodes, { ...graph.nodes[0]! }],
    };
    expect(
      validateCollaborationDagDefinition(mutated, {
        knownParticipantIds: participants,
        budget: P5_DEFAULT_BUDGET,
      }).some(issue => issue.code === "duplicate_dag_node"),
    ).toBe(true);
  });

  it("rejects unknown, self, and duplicate dependencies", () => {
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "architecture",
          participantId: "part_arch",
          instruction: "Plan",
          dependsOn: [],
        },
        {
          id: "review",
          participantId: "part_review",
          instruction: "Review",
          dependsOn: ["missing", "review", "architecture", "architecture"],
        },
      ],
    };
    const codes = validateCollaborationDagDefinition(graph, {
      knownParticipantIds: participants,
      budget: P5_DEFAULT_BUDGET,
    }).map(issue => issue.code);
    expect(codes).toContain("unknown_dependency");
    expect(codes).toContain("self_dependency");
    expect(codes).toContain("duplicate_dependency");
  });

  it("rejects cycles deterministically", () => {
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "a",
          participantId: "part_arch",
          instruction: "A",
          dependsOn: ["c"],
        },
        {
          id: "b",
          participantId: "part_critic",
          instruction: "B",
          dependsOn: ["a"],
        },
        {
          id: "c",
          participantId: "part_review",
          instruction: "C",
          dependsOn: ["b"],
        },
      ],
    };
    const issues = validateCollaborationDagDefinition(graph, {
      knownParticipantIds: participants,
      budget: P5_DEFAULT_BUDGET,
    });
    expect(issues.some(issue => issue.code === "collaboration_dag_cycle")).toBe(true);
  });

  it("rejects graphs that cannot fit into maxTurns", () => {
    const issues = validateCollaborationDagDefinition(validGraph(), {
      knownParticipantIds: participants,
      budget: { ...P5_DEFAULT_BUDGET, maxTurns: 3 },
    });
    expect(issues.some(issue => issue.code === "dag_nodes_exceed_turn_budget")).toBe(true);
  });

  it("rejects node retry and timeout values beyond run budget", () => {
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "architecture",
          participantId: "part_arch",
          instruction: "Plan",
          dependsOn: [],
          retryLimit: P5_DEFAULT_BUDGET.maxRetriesPerParticipant + 1,
          timeoutMs: P5_DEFAULT_BUDGET.maxWallClockMs + 1,
        },
      ],
    };
    const codes = validateCollaborationDagDefinition(graph, {
      knownParticipantIds: participants,
      budget: P5_DEFAULT_BUDGET,
    }).map(issue => issue.code);
    expect(codes).toContain("retry_limit_exceeded");
    expect(codes).toContain("node_timeout_exceeded");
  });

  it("produces deterministic topological order and fan-in metadata", () => {
    const plan = planCollaborationDag(validGraph(), {
      knownParticipantIds: participants,
      budget: P5_DEFAULT_BUDGET,
    });
    expect(plan.topologicalOrder).toEqual([
      "architecture",
      "critique",
      "implementation",
      "review",
    ]);
    expect(plan.rootNodeIds).toEqual(["architecture"]);
    expect(plan.sinkNodeIds).toEqual(["review"]);
    expect(plan.edgeCount).toBe(4);
    expect(plan.nodesById.architecture?.dependents).toEqual(["critique", "implementation"]);
    expect(plan.nodesById.review?.dependsOn).toEqual(["critique", "implementation"]);
    expect(plan.nodesById.review?.topologicalLevel).toBe(2);
  });

  it("uses declaration order for independent ready nodes, not completion order", () => {
    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        { id: "root", participantId: "part_arch", instruction: "Root", dependsOn: [] },
        { id: "second", participantId: "part_impl", instruction: "Second", dependsOn: ["root"] },
        { id: "first", participantId: "part_critic", instruction: "First", dependsOn: ["root"] },
        { id: "join", participantId: "part_review", instruction: "Join", dependsOn: ["first", "second"] },
      ],
    };
    const plan = planCollaborationDag(graph, {
      knownParticipantIds: participants,
      budget: P5_DEFAULT_BUDGET,
    });
    expect(plan.topologicalOrder).toEqual(["root", "second", "first", "join"]);
    expect(plan.nodesById.root?.dependents).toEqual(["second", "first"]);
    // Fan-in dependency order remains exactly the declared canonical order.
    expect(plan.nodesById.join?.dependsOn).toEqual(["first", "second"]);
  });

  it("throws structured fail-closed validation error when planning invalid graph", () => {
    const graph = validGraph();
    const invalid: CollaborationDagDefinition = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === "review" ? { ...node, dependsOn: ["missing"] } : node,
      ),
    };
    expect(() =>
      planCollaborationDag(invalid, {
        knownParticipantIds: participants,
        budget: P5_DEFAULT_BUDGET,
      }),
    ).toThrow(CollaborationDagValidationError);
  });
});
