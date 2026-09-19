import { describe, expect, it } from "bun:test";
import {
  BRIDGE_INTEGRATION_SCHEMA_VERSION,
  bridgeIntegrationCapabilities,
  createBridgeIntegrationDagRunProjection,
  normalizeBridgeIntegrationCorrelation,
} from "./integration-contract";
import type { RoleBasedCollaborationRun } from "./collaboration-domain";
import type {
  CollaborationDagNodeRecord,
  CollaborationDagRunMetadata,
} from "./collaboration-dag";

describe("P6 integration contract", () => {
  it("advertises only currently implemented integration capabilities", () => {
    expect(bridgeIntegrationCapabilities()).toEqual({
      schemaVersion: BRIDGE_INTEGRATION_SCHEMA_VERSION,
      service: "agent-chatgpt-bridge",
      authority: {
        collaboration: "bridge",
        execution: "external",
        coordination: "external",
      },
      capabilities: {
        dagRunProjection: true,
        dagRunCancellation: true,
        integrationEvents: false,
        dagRunSubmission: false,
      },
    });
  });

  it("projects DAG state without objective, instructions, summaries, outputs, or error messages", () => {
    const run: RoleBasedCollaborationRun = {
      id: "rrun_p6",
      sessionId: "ses_p6",
      objective: "SECRET OBJECTIVE MUST NOT LEAK",
      status: "running",
      round: 2,
      budget: {
        maxTurns: 8,
        maxParticipants: 3,
        maxParallelTurns: 2,
        maxRetriesPerParticipant: 1,
        maxWallClockMs: 60_000,
      },
      policy: {
        roleSequence: ["architect", "reviewer"],
        terminalRoles: ["reviewer"],
        loopMode: "once",
      },
      participantIds: ["part_arch", "part_review"],
      participantsById: {} as any,
      activeParticipantId: "part_review",
      turnHistory: ["turn_secret"],
      createdAt: "2026-09-19T00:00:00.000Z",
      startedAt: "2026-09-19T00:00:01.000Z",
      finalSummary: "SECRET SUMMARY MUST NOT LEAK",
    };

    const metadata: CollaborationDagRunMetadata = {
      runId: run.id,
      failurePolicy: "fail_fast",
      maxParallelTurns: 2,
      graph: {
        version: 1,
        nodes: [
          {
            id: "architecture",
            participantId: "part_arch",
            instruction: "SECRET NODE INSTRUCTION",
            dependsOn: [],
          },
          {
            id: "review",
            participantId: "part_review",
            instruction: "SECRET REVIEW INSTRUCTION",
            dependsOn: ["architecture"],
            terminal: true,
          },
        ],
      },
    };

    const nodes: CollaborationDagNodeRecord[] = [
      {
        id: "review",
        runId: run.id,
        participantId: "part_review",
        roleId: "reviewer",
        status: "running",
        declarationIndex: 1,
        attempt: 1,
        retryLimit: 1,
        startedAt: "2026-09-19T00:00:03.000Z",
      },
      {
        id: "architecture",
        runId: run.id,
        participantId: "part_arch",
        roleId: "architect",
        status: "failed",
        declarationIndex: 0,
        attempt: 1,
        retryLimit: 1,
        completedAt: "2026-09-19T00:00:02.000Z",
        outputMessageId: "msg_secret",
        error: {
          code: "provider_unavailable",
          message: "SECRET PROVIDER MESSAGE",
          retryable: true,
        },
      },
    ];

    const projection = createBridgeIntegrationDagRunProjection({ run, metadata, nodes });

    expect(projection.nodes.map(node => node.id)).toEqual(["architecture", "review"]);
    expect(projection.nodes[0]?.error).toEqual({
      code: "provider_unavailable",
      retryable: true,
    });

    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "SECRET OBJECTIVE MUST NOT LEAK",
      "SECRET SUMMARY MUST NOT LEAK",
      "SECRET NODE INSTRUCTION",
      "SECRET REVIEW INSTRUCTION",
      "SECRET PROVIDER MESSAGE",
      "msg_secret",
      "turn_secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("normalizes bounded ARC and CompanyOS correlation identifiers", () => {
    expect(normalizeBridgeIntegrationCorrelation({
      arcProjectId: " project-1 ",
      arcTaskId: "T001",
      companyWorkflowId: "WF_123",
      companyStepId: "step:review",
      externalTraceId: "trace/abc-123",
    })).toEqual({
      arcProjectId: "project-1",
      arcTaskId: "T001",
      companyWorkflowId: "WF_123",
      companyStepId: "step:review",
      externalTraceId: "trace/abc-123",
    });
  });

  it("rejects empty, oversized, whitespace-bearing, or arbitrary correlation content", () => {
    for (const value of [
      "",
      "contains spaces",
      "x".repeat(129),
      "../unsafe path",
      "line\nbreak",
    ]) {
      expect(() => normalizeBridgeIntegrationCorrelation({
        externalTraceId: value,
      })).toThrow();
    }
  });

});
