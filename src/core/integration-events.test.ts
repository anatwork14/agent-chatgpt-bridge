import { describe, expect, it } from "bun:test";
import { projectBridgeIntegrationEvent } from "./integration-events";

describe("P6 integration event projection", () => {
  it("projects only whitelisted lifecycle fields", () => {
    const projected = projectBridgeIntegrationEvent({
      id: 42,
      eventType: "collaboration.dag.node.failed",
      runId: "rrun_1",
      sessionId: "ses_1",
      createdAt: "2026-09-19T01:00:00.000Z",
      payload: {
        schemaVersion: 1,
        nodeId: "review",
        participantId: "part_review",
        roleId: "reviewer",
        attempt: 2,
        errorCode: "provider_unavailable",
        retryable: true,
        objective: "SECRET OBJECTIVE",
        prompt: "SECRET PROMPT",
        content: "SECRET MODEL OUTPUT",
        errorMessage: "SECRET PROVIDER DETAILS",
      },
    }, {
      arcProjectId: "project-1",
      arcTaskId: "T001",
    });

    expect(projected).toEqual({
      schemaVersion: 1,
      cursor: 42,
      type: "bridge.integration.node.failed",
      runId: "rrun_1",
      sessionId: "ses_1",
      occurredAt: "2026-09-19T01:00:00.000Z",
      correlation: {
        arcProjectId: "project-1",
        arcTaskId: "T001",
      },
      data: {
        nodeId: "review",
        participantId: "part_review",
        roleId: "reviewer",
        attempt: 2,
        errorCode: "provider_unavailable",
        retryable: true,
      },
    });

    const encoded = JSON.stringify(projected);
    for (const forbidden of [
      "SECRET OBJECTIVE",
      "SECRET PROMPT",
      "SECRET MODEL OUTPUT",
      "SECRET PROVIDER DETAILS",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("drops unknown or non-addressable audit records", () => {
    expect(projectBridgeIntegrationEvent({
      id: 1,
      eventType: "provider.route",
      runId: "rrun_1",
      sessionId: "ses_1",
      createdAt: "2026-09-19T01:00:00.000Z",
      payload: { provider: "secret" },
    })).toBeNull();

    expect(projectBridgeIntegrationEvent({
      eventType: "collaboration.dag.completed",
      runId: "rrun_1",
      sessionId: "ses_1",
      createdAt: "2026-09-19T01:00:00.000Z",
      payload: { schemaVersion: 1, nodeCount: 1, totalAttempts: 1 },
    })).toBeNull();
  });
});
