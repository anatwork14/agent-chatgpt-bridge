import { describe, expect, it } from "bun:test";
import type { CollaborationDagDefinition } from "./collaboration-dag";
import { P5_DEFAULT_BUDGET } from "./collaboration-dag";
import { planCollaborationDag } from "./collaboration-dag-validation";
import { runBoundedCollaborationDag } from "./collaboration-dag-scheduler";
import { BridgeError } from "./errors";

const participantIds = new Set(["p_arch", "p_a", "p_b", "p_join"]);

function plan(graph: CollaborationDagDefinition) {
  return planCollaborationDag(graph, {
    knownParticipantIds: participantIds,
    budget: P5_DEFAULT_BUDGET,
  });
}

describe("P5 bounded collaboration DAG scheduler", () => {
  it("executes independent branches concurrently and gates fan-in", async () => {
    const p = plan({
      version: 1,
      nodes: [
        { id: "root", participantId: "p_arch", instruction: "root", dependsOn: [] },
        { id: "branch_a", participantId: "p_a", instruction: "a", dependsOn: ["root"] },
        { id: "branch_b", participantId: "p_b", instruction: "b", dependsOn: ["root"] },
        { id: "join", participantId: "p_join", instruction: "join", dependsOn: ["branch_a", "branch_b"] },
      ],
    });

    let active = 0;
    let maxActive = 0;
    const completed = new Set<string>();

    const result = await runBoundedCollaborationDag(p, {
      maxParallelTurns: 2,
      async executeNode(node) {
        if (node.id === "join") {
          expect(completed.has("branch_a")).toBe(true);
          expect(completed.has("branch_b")).toBe(true);
        }
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, node.id.startsWith("branch_") ? 20 : 1));
        active--;
        completed.add(node.id);
        return node.id.toUpperCase();
      },
    });

    expect(result.dispatchOrder).toEqual(["root", "branch_a", "branch_b", "join"]);
    expect(result.outputsByNode.join).toBe("JOIN");
    expect(result.maxObservedParallelism).toBe(2);
    expect(maxActive).toBe(2);
  });

  it("serializes independent nodes that share one participant", async () => {
    const p = plan({
      version: 1,
      nodes: [
        { id: "root", participantId: "p_arch", instruction: "root", dependsOn: [] },
        { id: "same_1", participantId: "p_a", instruction: "1", dependsOn: ["root"] },
        { id: "same_2", participantId: "p_a", instruction: "2", dependsOn: ["root"] },
        { id: "other", participantId: "p_b", instruction: "other", dependsOn: ["root"] },
      ],
    });

    let sameParticipantActive = 0;
    let maxSameParticipantActive = 0;

    const result = await runBoundedCollaborationDag(p, {
      maxParallelTurns: 3,
      async executeNode(node) {
        if (node.participantId === "p_a") {
          sameParticipantActive++;
          maxSameParticipantActive = Math.max(maxSameParticipantActive, sameParticipantActive);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        if (node.participantId === "p_a") sameParticipantActive--;
        return node.id;
      },
    });

    expect(maxSameParticipantActive).toBe(1);
    expect(result.dispatchOrder.indexOf("same_1")).toBeLessThan(result.dispatchOrder.indexOf("same_2"));
  });

  it("never exceeds configured global parallelism", async () => {
    const p = plan({
      version: 1,
      nodes: [
        { id: "a", participantId: "p_arch", instruction: "a", dependsOn: [] },
        { id: "b", participantId: "p_a", instruction: "b", dependsOn: [] },
        { id: "c", participantId: "p_b", instruction: "c", dependsOn: [] },
        { id: "d", participantId: "p_join", instruction: "d", dependsOn: [] },
      ],
    });

    let active = 0;
    let observed = 0;
    const result = await runBoundedCollaborationDag(p, {
      maxParallelTurns: 2,
      async executeNode(node) {
        active++;
        observed = Math.max(observed, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return node.id;
      },
    });

    expect(observed).toBe(2);
    expect(result.maxObservedParallelism).toBe(2);
  });

  it("fails closed and aborts sibling work when a node fails", async () => {
    const p = plan({
      version: 1,
      nodes: [
        { id: "a", participantId: "p_arch", instruction: "a", dependsOn: [] },
        { id: "b", participantId: "p_a", instruction: "b", dependsOn: [] },
      ],
    });

    let siblingSawAbort = false;
    try {
      await runBoundedCollaborationDag(p, {
        maxParallelTurns: 2,
        async executeNode(node, { signal }) {
          if (node.id === "a") {
            await new Promise(resolve => setTimeout(resolve, 2));
            throw new Error("boom");
          }
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 100);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              siblingSawAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
          return node.id;
        },
      });
      throw new Error("expected scheduler failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("collaboration_dag_node_failed");
    }
    expect(siblingSawAbort).toBe(true);
  });

  it("rejects parallelism beyond the P5 hard cap", async () => {
    const p = plan({
      version: 1,
      nodes: [{ id: "a", participantId: "p_arch", instruction: "a", dependsOn: [] }],
    });

    try {
      await runBoundedCollaborationDag(p, {
        maxParallelTurns: 999,
        async executeNode() {
          return "never";
        },
      });
      throw new Error("expected invalid parallelism");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("invalid_parallelism");
    }
  });
});


it("reports external abort as collaboration_dag_cancelled and aborts active nodes", async () => {
  const p = plan({
    version: 1,
    nodes: [
      { id: "a", participantId: "p_arch", instruction: "a", dependsOn: [] },
      { id: "b", participantId: "p_a", instruction: "b", dependsOn: [] },
    ],
  });
  const controller = new AbortController();
  let abortedCount = 0;

  const execution = runBoundedCollaborationDag(p, {
    maxParallelTurns: 2,
    signal: controller.signal,
    async executeNode(_node, { signal }) {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("late"), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          abortedCount++;
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
    },
  });

  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new DOMException("user cancelled", "AbortError"));

  try {
    await execution;
    throw new Error("expected cancellation");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe("collaboration_dag_cancelled");
  }
  expect(abortedCount).toBe(2);
});


it("skip_dependents skips the full transitive dependent chain and continues independent work", async () => {
  const p = plan({
    version: 1,
    nodes: [
      { id: "root_a", participantId: "p_arch", instruction: "a", dependsOn: [] },
      { id: "child_a", participantId: "p_a", instruction: "child", dependsOn: ["root_a"] },
      { id: "join_a", participantId: "p_join", instruction: "join", dependsOn: ["child_a"] },
      { id: "root_b", participantId: "p_b", instruction: "b", dependsOn: [] },
    ],
  });

  const executed: string[] = [];
  const transitions: Array<{ nodeId: string; to: string }> = [];
  const result = await runBoundedCollaborationDag(p, {
    maxParallelTurns: 2,
    failurePolicy: "skip_dependents",
    onTransition: transition => transitions.push({ nodeId: transition.nodeId, to: transition.to }),
    async executeNode(node) {
      executed.push(node.id);
      if (node.id === "root_a") {
        throw new Error("branch failed");
      }
      await new Promise(resolve => setTimeout(resolve, 2));
      return node.id;
    },
  });

  expect(result.failedNodeIds).toEqual(["root_a"]);
  expect(result.skippedNodeIds).toEqual(["child_a", "join_a"]);
  expect(executed).toContain("root_b");
  expect(executed).not.toContain("child_a");
  expect(executed).not.toContain("join_a");
  expect(transitions).toContainEqual({ nodeId: "child_a", to: "skipped" });
  expect(transitions).toContainEqual({ nodeId: "join_a", to: "skipped" });
});

it("skip_dependents preserves declaration-order determinism for skipped descendants", async () => {
  const p = plan({
    version: 1,
    nodes: [
      { id: "root", participantId: "p_arch", instruction: "root", dependsOn: [] },
      { id: "first", participantId: "p_a", instruction: "first", dependsOn: ["root"] },
      { id: "second", participantId: "p_b", instruction: "second", dependsOn: ["root"] },
      { id: "join", participantId: "p_join", instruction: "join", dependsOn: ["first", "second"] },
    ],
  });

  const result = await runBoundedCollaborationDag(p, {
    maxParallelTurns: 2,
    failurePolicy: "skip_dependents",
    async executeNode(node) {
      if (node.id === "root") throw new Error("root failed");
      return node.id;
    },
  });

  expect(result.skippedNodeIds).toEqual(["first", "second", "join"]);
  expect(result.dispatchOrder).toEqual(["root"]);
});
