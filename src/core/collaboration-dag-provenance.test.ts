import { describe, expect, it } from "bun:test";
import { P5_DEFAULT_BUDGET, type CollaborationDagDefinition } from "./collaboration-dag";
import { planCollaborationDag } from "./collaboration-dag-validation";
import {
  assembleCollaborationDagInput,
} from "./collaboration-dag-provenance";
import {
  computeCollaborationMessageHash,
  type CollaborationMessageRecord,
} from "./collaboration-transcript";
import { BridgeError } from "./errors";

const participants = new Set(["p_a", "p_b", "p_join"]);

const graph: CollaborationDagDefinition = {
  version: 1,
  nodes: [
    { id: "a", participantId: "p_a", instruction: "A", dependsOn: [] },
    { id: "b", participantId: "p_b", instruction: "B", dependsOn: [] },
    { id: "join", participantId: "p_join", instruction: "Join", dependsOn: ["b", "a"] },
  ],
};

const plan = planCollaborationDag(graph, {
  knownParticipantIds: participants,
  budget: P5_DEFAULT_BUDGET,
});

function message(
  nodeId: string,
  id: string,
  participantId: string,
  roleId: string,
  content: string,
): CollaborationMessageRecord {
  const turnId = `turn_${nodeId}`;
  return {
    id,
    runId: "run_1",
    turnId,
    sequenceIndex: nodeId === "a" ? 0 : 1,
    senderParticipantId: participantId,
    senderRoleId: roleId,
    decisionType: "message",
    content,
    contentHash: computeCollaborationMessageHash({
      runId: "run_1",
      turnId,
      participantId,
      roleId,
      decisionType: "message",
      content,
    }),
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("P5 DAG fan-in provenance", () => {
  it("assembles predecessor outputs in declared dependency order", () => {
    const a = message("a", "msg_a", "p_a", "critic", "A output");
    const b = message("b", "msg_b", "p_b", "implementer", "B output");

    const assembled = assembleCollaborationDagInput({
      runId: "run_1",
      nodeId: "join",
      plan,
      messagesByNodeId: { a, b },
      assembledAt: "2026-09-18T00:00:01.000Z",
    });

    expect(assembled.provenance.predecessorNodeIds).toEqual(["b", "a"]);
    expect(assembled.provenance.predecessorMessageIds).toEqual(["msg_b", "msg_a"]);
    expect(assembled.priorTurns.map(turn => turn.text)).toEqual(["B output", "A output"]);
  });

  it("does not leak unrelated sibling output", () => {
    const a = message("a", "msg_a", "p_a", "critic", "A output");
    const b = message("b", "msg_b", "p_b", "implementer", "B output");
    const unrelated = message("x", "msg_x", "p_b", "implementer", "SECRET SIBLING");

    const assembled = assembleCollaborationDagInput({
      runId: "run_1",
      nodeId: "join",
      plan,
      messagesByNodeId: { a, b, x: unrelated },
      assembledAt: "2026-09-18T00:00:01.000Z",
    });

    expect(assembled.predecessorMessages.map(item => item.id)).toEqual(["msg_b", "msg_a"]);
    expect(assembled.priorTurns.some(turn => turn.text.includes("SECRET"))).toBe(false);
  });

  it("fails closed when a predecessor output is missing", () => {
    const b = message("b", "msg_b", "p_b", "implementer", "B output");
    expect(() =>
      assembleCollaborationDagInput({
        runId: "run_1",
        nodeId: "join",
        plan,
        messagesByNodeId: { b },
        assembledAt: "2026-09-18T00:00:01.000Z",
      }),
    ).toThrow(BridgeError);
  });

  it("fails closed on tampered predecessor content", () => {
    const a = message("a", "msg_a", "p_a", "critic", "A output");
    const b = message("b", "msg_b", "p_b", "implementer", "B output");
    const tampered = { ...a, content: "tampered" };

    try {
      assembleCollaborationDagInput({
        runId: "run_1",
        nodeId: "join",
        plan,
        messagesByNodeId: { a: tampered, b },
        assembledAt: "2026-09-18T00:00:01.000Z",
      });
      throw new Error("expected integrity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("collaboration_transcript_integrity_failed");
    }
  });

  it("rejects predecessor messages from another run", () => {
    const a = message("a", "msg_a", "p_a", "critic", "A output");
    const b = message("b", "msg_b", "p_b", "implementer", "B output");
    const wrongRun = { ...a, runId: "run_other" };

    try {
      assembleCollaborationDagInput({
        runId: "run_1",
        nodeId: "join",
        plan,
        messagesByNodeId: { a: wrongRun, b },
        assembledAt: "2026-09-18T00:00:01.000Z",
      });
      throw new Error("expected run mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("collaboration_dag_input_run_mismatch");
    }
  });
});
