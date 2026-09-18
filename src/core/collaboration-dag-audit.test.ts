import { describe, expect, it } from "bun:test";
import {
  assertSafeCollaborationDagAuditPayload,
  emitCollaborationDagAuditEvent,
} from "./collaboration-dag-audit";
import { BridgeError } from "./errors";

class FakeAuditStore {
  readonly events: any[] = [];
  log(event: any) {
    this.events.push(event);
  }
}

describe("P5 collaboration DAG audit", () => {
  it("accepts bounded identifier-only node events", () => {
    expect(() =>
      assertSafeCollaborationDagAuditPayload("collaboration.dag.node.started", {
        schemaVersion: 1,
        nodeId: "critic",
        participantId: "part_1",
        roleId: "critic",
        attempt: 1,
        turnIndex: 4,
      }),
    ).not.toThrow();
  });

  it("fails closed when prompt/output or credentials are added to a payload", () => {
    for (const bad of [
      { schemaVersion: 1, nodeId: "a", participantId: "p", roleId: "critic", attempt: 1, turnIndex: 0, prompt: "secret prompt" },
      { schemaVersion: 1, nodeId: "a", participantId: "p", roleId: "critic", attempt: 1, turnIndex: 0, accessToken: "secret" },
      { schemaVersion: 1, nodeId: "a", participantId: "p", roleId: "critic", attempt: 1, turnIndex: 0, content: "model output" },
    ]) {
      expect(() =>
        assertSafeCollaborationDagAuditPayload(
          "collaboration.dag.node.started",
          bad as any,
        ),
      ).toThrow(BridgeError);
    }
  });

  it("writes a validated minimized event to AuditStore", () => {
    const store = new FakeAuditStore();
    emitCollaborationDagAuditEvent(store as any, {
      eventType: "collaboration.dag.validated",
      runId: "run_1",
      sessionId: "ses_1",
      payload: {
        schemaVersion: 1,
        nodeCount: 4,
        edgeCount: 4,
        rootCount: 1,
        sinkCount: 1,
      },
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0].eventType).toBe("collaboration.dag.validated");
    expect(JSON.stringify(store.events[0])).not.toContain("objective");
  });
});
