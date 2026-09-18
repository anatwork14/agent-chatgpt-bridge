import {
  P5_LIMITS,
  type CollaborationDagExecutionPlan,
  type CollaborationDagPlannedNode,
} from "./collaboration-dag";
import { BridgeError } from "./errors";

export type CollaborationDagSchedulerNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CollaborationDagSchedulerTransition {
  readonly nodeId: string;
  readonly from: CollaborationDagSchedulerNodeStatus;
  readonly to: CollaborationDagSchedulerNodeStatus;
}

export interface CollaborationDagSchedulerOptions<T> {
  readonly maxParallelTurns: number;
  readonly signal?: AbortSignal;
  readonly executeNode: (
    node: CollaborationDagPlannedNode,
    context: { readonly signal: AbortSignal },
  ) => Promise<T>;
  readonly onTransition?: (transition: CollaborationDagSchedulerTransition) => void;
}

export interface CollaborationDagSchedulerResult<T> {
  readonly outputsByNode: Readonly<Record<string, T>>;
  readonly dispatchOrder: readonly string[];
  readonly completionOrder: readonly string[];
  readonly maxObservedParallelism: number;
}

/**
 * Executes only dependency and concurrency semantics for a validated P5 plan.
 *
 * Persistence, retries, per-node timeouts, and audit emission belong to RunController.
 * This core scheduler is intentionally provider-agnostic and deterministic.
 */
export async function runBoundedCollaborationDag<T>(
  plan: CollaborationDagExecutionPlan,
  options: CollaborationDagSchedulerOptions<T>,
): Promise<CollaborationDagSchedulerResult<T>> {
  if (
    !Number.isInteger(options.maxParallelTurns) ||
    options.maxParallelTurns <= 0 ||
    options.maxParallelTurns > P5_LIMITS.maxParallelTurns
  ) {
    throw new BridgeError(
      "invalid_parallelism",
      `maxParallelTurns must be an integer between 1 and ${P5_LIMITS.maxParallelTurns}`,
      false,
    );
  }

  const rootAbort = new AbortController();
  const onExternalAbort = () => rootAbort.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    rootAbort.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const statuses = new Map<string, CollaborationDagSchedulerNodeStatus>(
    plan.nodeIds.map(id => [id, "pending"]),
  );
  const completed = new Set<string>();
  const activeParticipants = new Set<string>();
  const active = new Map<
    string,
    {
      readonly participantId: string;
      readonly promise: Promise<
        | { readonly ok: true; readonly nodeId: string; readonly output: T }
        | { readonly ok: false; readonly nodeId: string; readonly error: unknown }
      >;
    }
  >();
  const outputsByNode: Record<string, T> = {};
  const dispatchOrder: string[] = [];
  const completionOrder: string[] = [];
  let maxObservedParallelism = 0;

  const transition = (
    nodeId: string,
    to: CollaborationDagSchedulerNodeStatus,
  ): void => {
    const from = statuses.get(nodeId);
    if (!from) {
      throw new BridgeError(
        "invalid_collaboration_dag_state",
        `Unknown scheduler node '${nodeId}'`,
        false,
      );
    }
    statuses.set(nodeId, to);
    options.onTransition?.({ nodeId, from, to });
  };

  try {
    while (completed.size < plan.nodeIds.length) {
      if (rootAbort.signal.aborted && active.size === 0) {
        for (const nodeId of plan.nodeIds) {
          if (statuses.get(nodeId) === "pending" || statuses.get(nodeId) === "ready") {
            transition(nodeId, "cancelled");
          }
        }
        throw new BridgeError(
          "collaboration_dag_cancelled",
          "Collaboration DAG execution was cancelled",
          false,
        );
      }

      // Mark dependency-satisfied nodes ready in deterministic topological order.
      for (const nodeId of plan.topologicalOrder) {
        if (statuses.get(nodeId) !== "pending") continue;
        const node = plan.nodesById[nodeId]!;
        if (node.dependsOn.every(depId => completed.has(depId))) {
          transition(nodeId, "ready");
        }
      }

      // Fill available slots, preserving one active turn per participant.
      for (const nodeId of plan.topologicalOrder) {
        if (active.size >= options.maxParallelTurns) break;
        if (statuses.get(nodeId) !== "ready") continue;
        const node = plan.nodesById[nodeId]!;
        if (activeParticipants.has(node.participantId)) continue;
        if (rootAbort.signal.aborted) break;

        transition(nodeId, "running");
        activeParticipants.add(node.participantId);
        dispatchOrder.push(nodeId);

        const promise = Promise.resolve()
          .then(() => options.executeNode(node, { signal: rootAbort.signal }))
          .then(
            output => ({ ok: true as const, nodeId, output }),
            error => ({ ok: false as const, nodeId, error }),
          );

        active.set(nodeId, {
          participantId: node.participantId,
          promise,
        });
        maxObservedParallelism = Math.max(maxObservedParallelism, active.size);
      }

      if (active.size === 0) {
        if (rootAbort.signal.aborted) {
          continue;
        }
        const remaining = plan.nodeIds.filter(id => !completed.has(id));
        throw new BridgeError(
          "collaboration_dag_deadlock",
          `Validated DAG scheduler made no progress; remaining nodes: ${remaining.join(", ")}`,
          false,
        );
      }

      const settled = await Promise.race([...active.values()].map(entry => entry.promise));
      const entry = active.get(settled.nodeId);
      if (!entry) {
        throw new BridgeError(
          "invalid_collaboration_dag_state",
          `Missing active scheduler entry for node '${settled.nodeId}'`,
          false,
        );
      }
      active.delete(settled.nodeId);
      activeParticipants.delete(entry.participantId);

      if (settled.ok) {
        transition(settled.nodeId, "completed");
        completed.add(settled.nodeId);
        outputsByNode[settled.nodeId] = settled.output;
        completionOrder.push(settled.nodeId);
        continue;
      }

      const externallyCancelled = rootAbort.signal.aborted;
      transition(settled.nodeId, externallyCancelled ? "cancelled" : "failed");
      if (!externallyCancelled) {
        rootAbort.abort(
          settled.error instanceof Error
            ? settled.error
            : new Error(String(settled.error)),
        );
      }

      // Drain siblings so callers never inherit detached execution promises.
      const siblingResults = await Promise.all([...active.values()].map(item => item.promise));
      for (const sibling of siblingResults) {
        const siblingEntry = active.get(sibling.nodeId);
        if (siblingEntry) {
          activeParticipants.delete(siblingEntry.participantId);
          active.delete(sibling.nodeId);
        }
        if (statuses.get(sibling.nodeId) === "running") {
          transition(sibling.nodeId, sibling.ok ? "completed" : "cancelled");
          if (sibling.ok) {
            completed.add(sibling.nodeId);
            outputsByNode[sibling.nodeId] = sibling.output;
            completionOrder.push(sibling.nodeId);
          }
        }
      }

      if (externallyCancelled) {
        throw new BridgeError(
          "collaboration_dag_cancelled",
          "Collaboration DAG execution was cancelled",
          false,
        );
      }

      throw new BridgeError(
        "collaboration_dag_node_failed",
        `DAG node '${settled.nodeId}' failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`,
        false,
      );
    }

    return {
      outputsByNode,
      dispatchOrder,
      completionOrder,
      maxObservedParallelism,
    };
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
