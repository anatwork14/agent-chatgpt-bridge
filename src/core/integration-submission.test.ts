import { describe, expect, it } from "bun:test";
import type { CollaborationConfig, ParticipantRecord } from "./collaboration-domain";
import type { PreparedParticipants } from "../agents/participant-factory";
import {
  createBridgeIntegrationDagSubmitter,
  parseBridgeIntegrationDagSubmission,
} from "./integration-submission";

function validRequest() {
  return {
    schemaVersion: 1,
    sessionId: "ses_existing_1",
    objective: "Review the proposed integration boundary",
    participants: [
      {
        roleId: "architect",
        adapterType: "acp:claude",
        permissionMode: "deny",
      },
      {
        roleId: "reviewer",
        adapterType: "acp:antigravity",
        permissionMode: "allow_readonly",
      },
    ],
    graph: {
      version: 1,
      nodes: [
        {
          id: "architecture",
          roleId: "architect",
          instruction: "Produce the bounded architecture.",
          dependsOn: [],
        },
        {
          id: "review",
          roleId: "reviewer",
          instruction: "Review the architecture.",
          dependsOn: ["architecture"],
          terminal: true,
        },
      ],
    },
    budget: {
      maxTurns: 6,
      maxParticipants: 2,
      maxParallelTurns: 2,
      maxRetriesPerParticipant: 1,
      maxWallClockMs: 60_000,
    },
    failurePolicy: "fail_fast",
    correlation: {
      arcProjectId: "project-1",
      arcTaskId: "T001",
      companyWorkflowId: "WF_001",
      companyStepId: "step:review",
    },
  };
}

describe("P6 integration DAG submission", () => {
  it("accepts only built-in ACP profile bindings and normalized correlation", () => {
    const parsed = parseBridgeIntegrationDagSubmission(validRequest());
    expect(parsed.participants).toEqual([
      {
        roleId: "architect",
        adapterType: "acp:claude",
        permissionMode: "deny",
      },
      {
        roleId: "reviewer",
        adapterType: "acp:antigravity",
        permissionMode: "allow_readonly",
      },
    ]);
    expect(parsed.correlation).toEqual({
      arcProjectId: "project-1",
      arcTaskId: "T001",
      companyWorkflowId: "WF_001",
      companyStepId: "step:review",
    });
  });

  it("rejects arbitrary execution, credentials, delegate mode, and generic ACP", () => {
    const cases = [
      {
        ...validRequest(),
        command: ["sh", "-c", "danger"],
      },
      {
        ...validRequest(),
        cwd: "/tmp/private",
      },
      {
        ...validRequest(),
        apiKey: "SECRET",
      },
      {
        ...validRequest(),
        participants: [{
          roleId: "architect",
          adapterType: "acp:claude",
          permissionMode: "delegate",
        }],
      },
      {
        ...validRequest(),
        participants: [{
          roleId: "architect",
          adapterType: "acp",
          permissionMode: "deny",
        }],
      },
    ];

    for (const request of cases) {
      expect(() => parseBridgeIntegrationDagSubmission(request)).toThrow();
    }
  });

  it("rejects duplicate roles and nodes without submitted role bindings", () => {
    expect(() => parseBridgeIntegrationDagSubmission({
      ...validRequest(),
      participants: [
        validRequest().participants[0],
        validRequest().participants[0],
      ],
    })).toThrow();

    expect(() => parseBridgeIntegrationDagSubmission({
      ...validRequest(),
      graph: {
        version: 1,
        nodes: [{
          id: "implementation",
          roleId: "implementer",
          instruction: "Implement",
          dependsOn: [],
          terminal: true,
        }],
      },
    })).toThrow();
  });

  it("maps role-addressed nodes to Bridge-owned participant IDs and returns a safe projection", async () => {
    let capturedConfig: CollaborationConfig | undefined;
    let capturedGraph: any;
    let capturedOptions: any;

    const prepareParticipantsFn = (
      config: CollaborationConfig,
    ): PreparedParticipants => {
      capturedConfig = config;
      const plans = config.policy.roleSequence.map((roleId, index) => {
        const assignment = (config.roles as any[]).find(item => item.roleId === roleId);
        return {
          roleId,
          participantId: `part_${roleId}`,
          sequenceIndex: index,
          adapterId: assignment.participantConfig.adapterType,
          role: {
            id: roleId,
            name: String(roleId),
            description: "test",
            systemInstructions: "test",
          },
          config: assignment.participantConfig,
        };
      });
      const participantsById: Record<string, ParticipantRecord> = {};
      for (const plan of plans) {
        participantsById[plan.participantId] = {
          id: plan.participantId,
          roleId: plan.roleId,
          adapterId: plan.adapterId,
          status: "pending",
          turnsExecuted: 0,
          consecutiveFailures: 0,
          createdAt: "2026-09-19T02:00:00.000Z",
        };
      }
      return {
        plans,
        runtimes: [],
        records: {
          participantIds: plans.map(plan => plan.participantId),
          participantsById,
        },
      } as PreparedParticipants;
    };

    const controller = {
      startDagRun: async (
        _sessionId: string,
        _config: CollaborationConfig,
        _prepared: PreparedParticipants,
        graph: any,
        options: any,
      ) => {
        capturedGraph = graph;
        capturedOptions = options;
        return { id: "rrun_submit_1" } as any;
      },
      getDagRunSnapshot: (runId: string) => ({
        run: {
          id: runId,
          sessionId: "ses_existing_1",
          objective: "SECRET OBJECTIVE",
          status: "running",
          round: 0,
          budget: {
            maxTurns: 6,
            maxParticipants: 2,
            maxParallelTurns: 2,
            maxRetriesPerParticipant: 1,
            maxWallClockMs: 60_000,
          },
          policy: {
            roleSequence: ["architect", "reviewer"],
            loopMode: "once",
            terminalRoles: ["reviewer"],
          },
          participantIds: ["part_architect", "part_reviewer"],
          participantsById: {},
          turnHistory: [],
          createdAt: "2026-09-19T02:00:00.000Z",
          startedAt: "2026-09-19T02:00:00.000Z",
        },
        metadata: {
          runId,
          graph: capturedGraph,
          failurePolicy: capturedOptions.failurePolicy,
          maxParallelTurns: 2,
        },
        correlation: capturedOptions.correlation,
        nodes: [
          {
            id: "architecture",
            runId,
            participantId: "part_architect",
            roleId: "architect",
            status: "ready",
            declarationIndex: 0,
            attempt: 0,
            retryLimit: 1,
          },
          {
            id: "review",
            runId,
            participantId: "part_reviewer",
            roleId: "reviewer",
            status: "pending",
            declarationIndex: 1,
            attempt: 0,
            retryLimit: 1,
          },
        ],
      }) as any,
    };

    const submit = createBridgeIntegrationDagSubmitter(controller as any, {
      prepareParticipantsFn,
    });
    const projection = await submit(validRequest());

    expect(capturedConfig?.policy).toEqual({
      roleSequence: ["architect", "reviewer"],
      loopMode: "once",
      terminalRoles: ["reviewer"],
    });
    expect((capturedConfig?.roles as any[]).map(item => item.participantConfig)).toEqual([
      {
        adapterType: "acp:claude",
        config: { permissionMode: "deny" },
      },
      {
        adapterType: "acp:antigravity",
        config: { permissionMode: "allow_readonly" },
      },
    ]);
    expect(capturedGraph.nodes.map((node: any) => [node.id, node.participantId])).toEqual([
      ["architecture", "part_architect"],
      ["review", "part_reviewer"],
    ]);
    expect(capturedOptions.failurePolicy).toBe("fail_fast");
    expect(capturedOptions.budget.maxParallelTurns).toBe(2);
    expect(capturedOptions.correlation.arcTaskId).toBe("T001");

    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain("SECRET OBJECTIVE");
    expect(encoded).not.toContain("Produce the bounded architecture.");
    expect(projection.correlation?.companyStepId).toBe("step:review");
  });
});
