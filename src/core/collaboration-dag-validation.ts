import {
  P5_DAG_NODE_ID_REGEX,
  P5_LIMITS,
  type CollaborationDagBudget,
  type CollaborationDagDefinition,
  type CollaborationDagExecutionPlan,
  type CollaborationDagNodeDefinition,
  type CollaborationDagPlannedNode,
} from "./collaboration-dag";
import { P4_LIMITS } from "./collaboration-domain";
import { BridgeError } from "./errors";

export interface CollaborationDagValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class CollaborationDagValidationError extends BridgeError {
  constructor(public readonly issues: readonly CollaborationDagValidationIssue[]) {
    const detail = issues.map(issue => `${issue.path}: [${issue.code}] ${issue.message}`).join("; ");
    super("invalid_collaboration_dag", `Collaboration DAG validation failed: ${detail}`, false);
    this.name = "CollaborationDagValidationError";
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isValidCollaborationDagNodeId(value: unknown): value is string {
  return typeof value === "string" && P5_DAG_NODE_ID_REGEX.test(value);
}

export function validateCollaborationDagBudget(
  budget: unknown,
  path = "budget",
): CollaborationDagValidationIssue[] {
  const issues: CollaborationDagValidationIssue[] = [];
  if (typeof budget !== "object" || budget === null) {
    return [{ code: "invalid_budget", path, message: "DAG budget must be a non-null object" }];
  }

  const b = budget as Partial<CollaborationDagBudget>;

  if (!positiveInteger(b.maxTurns)) {
    issues.push({ code: "invalid_budget", path: `${path}.maxTurns`, message: "maxTurns must be a positive integer" });
  } else if (b.maxTurns > P4_LIMITS.maxTurns) {
    issues.push({ code: "budget_limit_exceeded", path: `${path}.maxTurns`, message: `maxTurns exceeds hard limit ${P4_LIMITS.maxTurns}` });
  }

  if (!positiveInteger(b.maxParticipants)) {
    issues.push({ code: "invalid_budget", path: `${path}.maxParticipants`, message: "maxParticipants must be a positive integer" });
  } else if (b.maxParticipants > P4_LIMITS.maxParticipants) {
    issues.push({ code: "budget_limit_exceeded", path: `${path}.maxParticipants`, message: `maxParticipants exceeds hard limit ${P4_LIMITS.maxParticipants}` });
  }

  if (!positiveInteger(b.maxParallelTurns)) {
    issues.push({ code: "invalid_parallelism", path: `${path}.maxParallelTurns`, message: "maxParallelTurns must be a positive integer" });
  } else if (b.maxParallelTurns > P5_LIMITS.maxParallelTurns) {
    issues.push({
      code: "parallelism_limit_exceeded",
      path: `${path}.maxParallelTurns`,
      message: `maxParallelTurns exceeds P5 hard limit ${P5_LIMITS.maxParallelTurns}`,
    });
  }

  if (!nonNegativeInteger(b.maxRetriesPerParticipant)) {
    issues.push({ code: "invalid_budget", path: `${path}.maxRetriesPerParticipant`, message: "maxRetriesPerParticipant must be a non-negative integer" });
  } else if (b.maxRetriesPerParticipant > P4_LIMITS.maxRetriesPerParticipant) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxRetriesPerParticipant`,
      message: `maxRetriesPerParticipant exceeds hard limit ${P4_LIMITS.maxRetriesPerParticipant}`,
    });
  }

  if (!positiveInteger(b.maxWallClockMs)) {
    issues.push({ code: "invalid_budget", path: `${path}.maxWallClockMs`, message: "maxWallClockMs must be a positive integer" });
  } else if (b.maxWallClockMs > P4_LIMITS.maxWallClockMs) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxWallClockMs`,
      message: `maxWallClockMs exceeds hard limit ${P4_LIMITS.maxWallClockMs}`,
    });
  }

  return issues;
}

function validateNode(
  node: unknown,
  index: number,
  knownParticipantIds?: ReadonlySet<string>,
  budget?: CollaborationDagBudget,
): CollaborationDagValidationIssue[] {
  const path = `graph.nodes[${index}]`;
  const issues: CollaborationDagValidationIssue[] = [];
  if (typeof node !== "object" || node === null) {
    return [{ code: "invalid_dag_node", path, message: "Node must be a non-null object" }];
  }

  const n = node as Partial<CollaborationDagNodeDefinition>;
  if (!isValidCollaborationDagNodeId(n.id)) {
    issues.push({
      code: "invalid_dag_node_id",
      path: `${path}.id`,
      message: "Node id must match /^[a-z][a-z0-9_-]{0,63}$/",
    });
  }

  if (typeof n.participantId !== "string" || n.participantId.trim().length === 0) {
    issues.push({ code: "invalid_participant", path: `${path}.participantId`, message: "participantId must be a non-empty string" });
  } else if (knownParticipantIds && !knownParticipantIds.has(n.participantId)) {
    issues.push({
      code: "unknown_participant",
      path: `${path}.participantId`,
      message: `Unknown participant '${n.participantId}'`,
    });
  }

  if (typeof n.instruction !== "string" || n.instruction.trim().length === 0) {
    issues.push({ code: "invalid_node_instruction", path: `${path}.instruction`, message: "instruction must be a non-empty string" });
  } else if (n.instruction.length > P5_LIMITS.maxNodeInstructionChars) {
    issues.push({
      code: "node_instruction_too_large",
      path: `${path}.instruction`,
      message: `instruction exceeds ${P5_LIMITS.maxNodeInstructionChars} characters`,
    });
  }

  if (!Array.isArray(n.dependsOn)) {
    issues.push({ code: "invalid_dependencies", path: `${path}.dependsOn`, message: "dependsOn must be an array" });
  }

  if (n.terminal !== undefined && typeof n.terminal !== "boolean") {
    issues.push({ code: "invalid_terminal_flag", path: `${path}.terminal`, message: "terminal must be boolean when provided" });
  }

  if (n.retryLimit !== undefined) {
    if (!nonNegativeInteger(n.retryLimit)) {
      issues.push({ code: "invalid_retry_limit", path: `${path}.retryLimit`, message: "retryLimit must be a non-negative integer" });
    } else if (budget && n.retryLimit > budget.maxRetriesPerParticipant) {
      issues.push({
        code: "retry_limit_exceeded",
        path: `${path}.retryLimit`,
        message: "retryLimit cannot exceed the run maxRetriesPerParticipant budget",
      });
    }
  }

  if (n.timeoutMs !== undefined) {
    if (!positiveInteger(n.timeoutMs)) {
      issues.push({ code: "invalid_node_timeout", path: `${path}.timeoutMs`, message: "timeoutMs must be a positive integer" });
    } else if (budget && n.timeoutMs > budget.maxWallClockMs) {
      issues.push({
        code: "node_timeout_exceeded",
        path: `${path}.timeoutMs`,
        message: "timeoutMs cannot exceed the run maxWallClockMs budget",
      });
    }
  }

  return issues;
}

export function validateCollaborationDagDefinition(
  graph: unknown,
  options: {
    readonly knownParticipantIds?: ReadonlySet<string>;
    readonly budget?: CollaborationDagBudget;
  } = {},
): CollaborationDagValidationIssue[] {
  const issues: CollaborationDagValidationIssue[] = [];

  if (typeof graph !== "object" || graph === null) {
    return [{ code: "invalid_dag", path: "graph", message: "Graph must be a non-null object" }];
  }

  const g = graph as Partial<CollaborationDagDefinition>;
  if (g.version !== 1) {
    issues.push({ code: "unsupported_dag_version", path: "graph.version", message: "Only DAG version 1 is supported" });
  }
  if (!Array.isArray(g.nodes)) {
    issues.push({ code: "invalid_dag_nodes", path: "graph.nodes", message: "nodes must be an array" });
    return issues;
  }
  if (g.nodes.length === 0) {
    issues.push({ code: "empty_dag", path: "graph.nodes", message: "DAG must contain at least one node" });
    return issues;
  }
  if (g.nodes.length > P5_LIMITS.maxNodes) {
    issues.push({
      code: "dag_node_limit_exceeded",
      path: "graph.nodes",
      message: `DAG node count exceeds hard limit ${P5_LIMITS.maxNodes}`,
    });
  }
  if (options.budget && g.nodes.length > options.budget.maxTurns) {
    issues.push({
      code: "dag_nodes_exceed_turn_budget",
      path: "graph.nodes",
      message: "Every DAG node requires at least one turn, so node count cannot exceed maxTurns",
    });
  }

  const seen = new Set<string>();
  for (let index = 0; index < g.nodes.length; index++) {
    const node = g.nodes[index];
    issues.push(...validateNode(node, index, options.knownParticipantIds, options.budget));
    if (node && typeof node.id === "string") {
      if (seen.has(node.id)) {
        issues.push({
          code: "duplicate_dag_node",
          path: `graph.nodes[${index}].id`,
          message: `Duplicate node id '${node.id}'`,
        });
      }
      seen.add(node.id);
    }
  }

  let edgeCount = 0;
  for (let index = 0; index < g.nodes.length; index++) {
    const node = g.nodes[index];
    if (!node || !Array.isArray(node.dependsOn)) continue;
    const local = new Set<string>();
    for (let depIndex = 0; depIndex < node.dependsOn.length; depIndex++) {
      const dependency = node.dependsOn[depIndex];
      edgeCount++;
      const depPath = `graph.nodes[${index}].dependsOn[${depIndex}]`;
      if (typeof dependency !== "string" || !isValidCollaborationDagNodeId(dependency)) {
        issues.push({ code: "invalid_dependency_id", path: depPath, message: "Dependency id is invalid" });
        continue;
      }
      if (dependency === node.id) {
        issues.push({ code: "self_dependency", path: depPath, message: "Node cannot depend on itself" });
      }
      if (local.has(dependency)) {
        issues.push({ code: "duplicate_dependency", path: depPath, message: `Duplicate dependency '${dependency}'` });
      }
      local.add(dependency);
      if (!seen.has(dependency)) {
        issues.push({ code: "unknown_dependency", path: depPath, message: `Unknown dependency '${dependency}'` });
      }
    }
  }

  if (edgeCount > P5_LIMITS.maxEdges) {
    issues.push({
      code: "dag_edge_limit_exceeded",
      path: "graph.nodes",
      message: `DAG edge count exceeds hard limit ${P5_LIMITS.maxEdges}`,
    });
  }

  // Only attempt cycle detection when every referenced dependency exists.
  const structuralDependencyError = issues.some(issue =>
    issue.code === "unknown_dependency" ||
    issue.code === "invalid_dependency_id" ||
    issue.code === "self_dependency" ||
    issue.code === "duplicate_dag_node"
  );

  if (!structuralDependencyError && seen.size === g.nodes.length) {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const declarationIndex = new Map<string, number>();

    g.nodes.forEach((node, index) => {
      indegree.set(node.id, node.dependsOn.length);
      dependents.set(node.id, []);
      declarationIndex.set(node.id, index);
    });
    g.nodes.forEach(node => {
      for (const dependency of node.dependsOn) {
        dependents.get(dependency)!.push(node.id);
      }
    });

    const compare = (a: string, b: string) =>
      (declarationIndex.get(a)! - declarationIndex.get(b)!) || a.localeCompare(b);
    const ready = g.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id).sort(compare);
    let processed = 0;
    while (ready.length > 0) {
      const current = ready.shift()!;
      processed++;
      const nextIds = dependents.get(current)!.slice().sort(compare);
      for (const dependent of nextIds) {
        const next = indegree.get(dependent)! - 1;
        indegree.set(dependent, next);
        if (next === 0) {
          ready.push(dependent);
          ready.sort(compare);
        }
      }
    }

    if (processed !== g.nodes.length) {
      issues.push({
        code: "collaboration_dag_cycle",
        path: "graph.nodes",
        message: "DAG contains at least one dependency cycle",
      });
    }
  }

  return issues;
}

export function planCollaborationDag(
  graph: CollaborationDagDefinition,
  options: {
    readonly knownParticipantIds?: ReadonlySet<string>;
    readonly budget?: CollaborationDagBudget;
  } = {},
): CollaborationDagExecutionPlan {
  const issues = validateCollaborationDagDefinition(graph, options);
  if (options.budget) {
    issues.push(...validateCollaborationDagBudget(options.budget));
  }
  if (issues.length > 0) {
    throw new CollaborationDagValidationError(issues);
  }

  const declarationIndex = new Map<string, number>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const levels = new Map<string, number>();
  const nodeById = new Map<string, CollaborationDagNodeDefinition>();

  graph.nodes.forEach((node, index) => {
    declarationIndex.set(node.id, index);
    indegree.set(node.id, node.dependsOn.length);
    dependents.set(node.id, []);
    levels.set(node.id, 0);
    nodeById.set(node.id, node);
  });
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      dependents.get(dependency)!.push(node.id);
    }
  }

  const compare = (a: string, b: string) =>
    (declarationIndex.get(a)! - declarationIndex.get(b)!) || a.localeCompare(b);

  for (const ids of dependents.values()) ids.sort(compare);

  const workIndegree = new Map(indegree);
  const ready = graph.nodes
    .filter(node => workIndegree.get(node.id) === 0)
    .map(node => node.id)
    .sort(compare);
  const topologicalOrder: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    topologicalOrder.push(current);
    for (const dependent of dependents.get(current)!) {
      levels.set(dependent, Math.max(levels.get(dependent)!, levels.get(current)! + 1));
      const next = workIndegree.get(dependent)! - 1;
      workIndegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compare);
      }
    }
  }

  const fallbackRetryLimit = options.budget?.maxRetriesPerParticipant ?? 0;
  const nodesById: Record<string, CollaborationDagPlannedNode> = {};
  for (const node of graph.nodes) {
    nodesById[node.id] = {
      id: node.id,
      participantId: node.participantId,
      instruction: node.instruction,
      dependsOn: [...node.dependsOn],
      dependents: [...dependents.get(node.id)!],
      declarationIndex: declarationIndex.get(node.id)!,
      indegree: indegree.get(node.id)!,
      topologicalLevel: levels.get(node.id)!,
      terminal: node.terminal === true,
      retryLimit: node.retryLimit ?? fallbackRetryLimit,
      timeoutMs: node.timeoutMs,
    };
  }

  const rootNodeIds = graph.nodes.filter(node => node.dependsOn.length === 0).map(node => node.id).sort(compare);
  const sinkNodeIds = graph.nodes.filter(node => dependents.get(node.id)!.length === 0).map(node => node.id).sort(compare);
  const edgeCount = graph.nodes.reduce((sum, node) => sum + node.dependsOn.length, 0);

  return {
    version: 1,
    edgeCount,
    nodeIds: graph.nodes.map(node => node.id),
    topologicalOrder,
    rootNodeIds,
    sinkNodeIds,
    nodesById,
  };
}
