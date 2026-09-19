import { afterEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../../core/session-manager";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { createBridgeApi } from "./routes";

function sessionManager(): SessionManager {
  return new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { fake: new FakeConversationProvider() },
  );
}

afterEach(() => closeDatabase());

describe("P6 integration REST contract", () => {
  it("advertises configured integration capabilities without exposing internals", async () => {
    initDatabase(":memory:");
    const app = createBridgeApi(sessionManager(), {
      apiToken: "local-secret",
      runController: {
        getDagRunSnapshot: () => null,
        cancelDagRun: async () => false,
      } as any,
    });

    const unauthorized = await app.request("/bridge/v1/integrations/capabilities");
    expect(unauthorized.status).toBe(401);

    const response = await app.request("/bridge/v1/integrations/capabilities", {
      headers: { authorization: "Bearer local-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
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

  it("returns a minimized DAG projection and never leaks objective/instructions/output", async () => {
    initDatabase(":memory:");
    const snapshot = {
      run: {
        id: "rrun_p6",
        sessionId: "ses_p6",
        objective: "TOP SECRET OBJECTIVE",
        status: "running",
        round: 1,
        budget: {
          maxTurns: 4,
          maxParticipants: 2,
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
        participantsById: {},
        turnHistory: ["turn_secret"],
        createdAt: "2026-09-19T00:00:00.000Z",
        startedAt: "2026-09-19T00:00:01.000Z",
        finalSummary: "TOP SECRET SUMMARY",
      },
      metadata: {
        runId: "rrun_p6",
        failurePolicy: "fail_fast",
        maxParallelTurns: 2,
        graph: {
          version: 1,
          nodes: [{
            id: "architecture",
            participantId: "part_arch",
            instruction: "TOP SECRET INSTRUCTION",
            dependsOn: [],
          }],
        },
      },
      nodes: [{
        id: "architecture",
        runId: "rrun_p6",
        participantId: "part_arch",
        roleId: "architect",
        status: "failed",
        declarationIndex: 0,
        attempt: 1,
        retryLimit: 1,
        outputMessageId: "msg_secret",
        error: {
          code: "provider_unavailable",
          message: "TOP SECRET ERROR DETAILS",
          retryable: true,
        },
      }],
    };

    const app = createBridgeApi(sessionManager(), {
      runController: {
        getDagRunSnapshot: (id: string) => id === "rrun_p6" ? snapshot : null,
        cancelDagRun: async () => false,
      } as any,
    });

    const response = await app.request("/bridge/v1/integrations/dag-runs/rrun_p6");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.nodes[0].error).toEqual({
      code: "provider_unavailable",
      retryable: true,
    });

    const raw = JSON.stringify(payload);
    for (const forbidden of [
      "TOP SECRET OBJECTIVE",
      "TOP SECRET SUMMARY",
      "TOP SECRET INSTRUCTION",
      "TOP SECRET ERROR DETAILS",
      "msg_secret",
      "turn_secret",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("cancels the exact Bridge DAG run with a fixed bridge-owned reason", async () => {
    initDatabase(":memory:");
    const calls: unknown[][] = [];
    const app = createBridgeApi(sessionManager(), {
      runController: {
        getDagRunSnapshot: (id: string) => id === "rrun_p6"
          ? {
              run: {
                id,
                sessionId: "ses_p6",
                objective: "hidden",
                status: "running",
                round: 0,
                budget: {
                  maxTurns: 1,
                  maxParticipants: 1,
                  maxParallelTurns: 1,
                  maxRetriesPerParticipant: 0,
                  maxWallClockMs: 1000,
                },
                policy: {
                  roleSequence: ["reviewer"],
                  terminalRoles: ["reviewer"],
                  loopMode: "once",
                },
                participantIds: ["part_review"],
                participantsById: {},
                turnHistory: [],
                createdAt: "2026-09-19T00:00:00.000Z",
              },
              metadata: {
                runId: id,
                failurePolicy: "fail_fast",
                maxParallelTurns: 1,
                graph: { version: 1, nodes: [] },
              },
              nodes: [],
            }
          : null,
        cancelDagRun: async (...args: unknown[]) => {
          calls.push(args);
          return true;
        },
      } as any,
    });

    const response = await app.request("/bridge/v1/integrations/dag-runs/rrun_p6/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "UNTRUSTED EXTERNAL REASON MUST BE IGNORED" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      cancelled: true,
      run_id: "rrun_p6",
    });
    expect(calls).toEqual([[
      "rrun_p6",
      "Cancelled by local integration client",
    ]]);
  });

  it("returns 404 for an unknown DAG run", async () => {
    initDatabase(":memory:");
    const app = createBridgeApi(sessionManager(), {
      runController: {
        getDagRunSnapshot: () => null,
        cancelDagRun: async () => false,
      } as any,
    });

    const response = await app.request("/bridge/v1/integrations/dag-runs/missing");
    expect(response.status).toBe(404);
  });
});
