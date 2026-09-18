import { expect, test, describe } from "bun:test";
import {
  P4_AUDIT_SCHEMA_VERSION,
  COLLABORATION_AUDIT_EVENT_TYPES,
  assertSafeCollaborationAuditPayload,
  emitCollaborationAuditEvent,
  buildCollaborationObservabilitySnapshot,
} from "./collaboration-audit";
import { BridgeError } from "./errors";
import type { AuditStore, AuditEventData } from "../persistence/audit-store";
import type {
  RoleBasedCollaborationRun,
  CollaborationTurnRecord,
} from "./collaboration-domain";

describe("Collaboration Audit Payload Validator", () => {
  test("schema version is strictly 1", () => {
    expect(P4_AUDIT_SCHEMA_VERSION).toBe(1);
  });

  test("accepts valid collaboration.started payload", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", {
        schemaVersion: 1,
        participantCount: 3,
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "once",
        budget: {
          maxTurns: 30,
          maxParticipants: 5,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 2,
          maxWallClockMs: 3600000,
        },
      }),
    ).not.toThrow();
  });

  test("rejects missing or invalid schemaVersion", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", {
        participantCount: 3,
        roleSequence: ["architect"],
        loopMode: "once",
        budget: {
          maxTurns: 30,
          maxParticipants: 5,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 2,
          maxWallClockMs: 3600000,
        },
      } as any),
    ).toThrow(BridgeError);

    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", {
        schemaVersion: 2,
        participantCount: 3,
        roleSequence: ["architect"],
        loopMode: "once",
        budget: {
          maxTurns: 30,
          maxParticipants: 5,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 2,
          maxWallClockMs: 3600000,
        },
      } as any),
    ).toThrow(BridgeError);
  });

  test("rejects unknown event type", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("unregistered.event" as any, {
        schemaVersion: 1,
      } as any),
    ).toThrow(BridgeError);
  });

  test("rejects non-object or null payloads", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", null),
    ).toThrow(BridgeError);
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", "string" as any),
    ).toThrow(BridgeError);
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", [] as any),
    ).toThrow(BridgeError);
  });

  test("rejects payloads containing forbidden raw content keys (Sections 11 & 12)", () => {
    const forbiddenKeyCases = [
      { objective: "secret objective" },
      { systemInstructions: "secret system prompt" },
      { modelOutput: "generated code" },
      { transcript: "full conversation" },
      { prompt: "user query" },
      { cwd: "/home/user/project" },
      { command: ["agy-acp"] },
      { token: "token_1234567890" },
      { secret: "super_secret" },
      { password: "admin" },
      { authorization: "Bearer xyz" },
      { cookie: "session=abc" },
      { apiKey: "sk-12345" },
      { api_key: "sk-12345" },
      { oauth: "token_data" },
      { credential: "cred" },
      { refreshToken: "rt_123" },
      { accessToken: "at_123" },
      { finalSummary: "summary text" },
      { summary: "done summary text" },
      { reason: "pause reason text" },
      { message: "agent message text" },
      { errorMessage: "failed connection" },
      { critique: "needs fix" },
      { content: "raw text" },
    ];

    for (const forbidden of forbiddenKeyCases) {
      expect(() =>
        assertSafeCollaborationAuditPayload("collaboration.completed", {
          schemaVersion: 1,
          round: 0,
          totalTurns: 1,
          ...forbidden,
        } as any),
      ).toThrow(BridgeError);
    }
  });

  test("accepts safe boolean and metadata indicators (reasonPresent, summaryPresent, decisionType, errorCode)", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.paused", {
        schemaVersion: 1,
        round: 1,
        turnIndex: 2,
        participantId: "part_1",
        roleId: "implementer",
        reasonPresent: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.cancel.requested", {
        schemaVersion: 1,
        activeParticipantId: "part_1",
        reasonPresent: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertSafeCollaborationAuditPayload("participant.turn.completed", {
        schemaVersion: 1,
        participantId: "part_1",
        roleId: "reviewer",
        round: 0,
        turnIndex: 3,
        decisionType: "done",
        durationMs: 1500,
      }),
    ).not.toThrow();

    expect(() =>
      assertSafeCollaborationAuditPayload("participant.turn.failed", {
        schemaVersion: 1,
        participantId: "part_1",
        roleId: "reviewer",
        round: 0,
        turnIndex: 3,
        errorCode: "agent_adapter_timeout",
        retryable: false,
        durationMs: 5000,
      }),
    ).not.toThrow();
  });

  test("rejects payloads exceeding 16 KiB (Section 14)", () => {
    const largeArray = new Array(2000).fill("test-role-id");
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.started", {
        schemaVersion: 1,
        participantCount: 2000,
        roleSequence: largeArray,
        loopMode: "once",
        budget: {
          maxTurns: 30,
          maxParticipants: 5,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: 2,
          maxWallClockMs: 3600000,
        },
      }),
    ).toThrow(BridgeError);
  });

  test("rejects functions and symbols in payload values", () => {
    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.completed", {
        schemaVersion: 1,
        round: 0,
        totalTurns: 1,
        fn: () => {},
      } as any),
    ).toThrow(BridgeError);

    expect(() =>
      assertSafeCollaborationAuditPayload("collaboration.completed", {
        schemaVersion: 1,
        round: 0,
        totalTurns: 1,
        sym: Symbol("test"),
      } as any),
    ).toThrow(BridgeError);
  });
});

describe("emitCollaborationAuditEvent", () => {
  test("emits validated event to AuditStore", () => {
    const logged: AuditEventData[] = [];
    const mockStore: AuditStore = {
      log: (event: AuditEventData) => logged.push(event),
      list: () => [],
      listByRun: () => [],
    };

    emitCollaborationAuditEvent(mockStore, {
      eventType: "participant.assigned",
      runId: "run_1",
      sessionId: "ses_1",
      createdAt: "2026-09-18T00:00:00Z",
      payload: {
        schemaVersion: 1,
        participantId: "part_arch",
        roleId: "architect",
        adapterId: "acp:antigravity",
        sequenceIndex: 0,
      },
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]!.eventType).toBe("participant.assigned");
    expect(logged[0]!.runId).toBe("run_1");
    expect(logged[0]!.sessionId).toBe("ses_1");
    expect((logged[0]!.payload as any).roleId).toBe("architect");
  });

  test("rethrows BridgeError on write failure without masking error code", () => {
    const failingStore: AuditStore = {
      log: () => {
        throw new Error("Disk full");
      },
      list: () => [],
      listByRun: () => [],
    };

    expect(() =>
      emitCollaborationAuditEvent(failingStore, {
        eventType: "collaboration.completed",
        runId: "run_1",
        sessionId: "ses_1",
        payload: { schemaVersion: 1, round: 0, totalTurns: 1 },
      }),
    ).toThrow(BridgeError);
  });
});

describe("buildCollaborationObservabilitySnapshot", () => {
  test("computes correct attempt counts and per-participant metrics", () => {
    const run: RoleBasedCollaborationRun = {
      id: "run_obs",
      sessionId: "ses_obs",
      objective: "obs test",
      status: "completed",
      round: 0,
      budget: {
        maxTurns: 10,
        maxParticipants: 3,
        maxParallelTurns: 1,
        maxRetriesPerParticipant: 2,
        maxWallClockMs: 60000,
      },
      policy: {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["implementer"],
      },
      participantIds: ["p_arch", "p_impl"],
      participantsById: {
        p_arch: {
          id: "p_arch",
          roleId: "architect",
          adapterId: "mock",
          status: "idle",
          turnsExecuted: 1,
          consecutiveFailures: 0,
          createdAt: "2026-09-18T00:00:00Z",
        },
        p_impl: {
          id: "p_impl",
          roleId: "implementer",
          adapterId: "mock",
          status: "idle",
          turnsExecuted: 2,
          consecutiveFailures: 0,
          createdAt: "2026-09-18T00:00:00Z",
        },
      },
      turnHistory: ["t1", "t2", "t3"],
      createdAt: "2026-09-18T00:00:00Z",
    };

    const turns: CollaborationTurnRecord[] = [
      {
        id: "t1",
        runId: "run_obs",
        round: 0,
        turnIndex: 0,
        participantId: "p_arch",
        roleId: "architect",
        status: "completed",
        inputSummary: "arch turn",
        startedAt: "2026-09-18T00:00:01Z",
        durationMs: 500,
      },
      {
        id: "t2",
        runId: "run_obs",
        round: 0,
        turnIndex: 1,
        participantId: "p_impl",
        roleId: "implementer",
        status: "failed",
        inputSummary: "impl retry turn",
        startedAt: "2026-09-18T00:00:02Z",
        durationMs: 200,
      },
      {
        id: "t3",
        runId: "run_obs",
        round: 0,
        turnIndex: 2,
        participantId: "p_impl",
        roleId: "implementer",
        status: "completed",
        inputSummary: "impl success turn",
        startedAt: "2026-09-18T00:00:03Z",
        durationMs: 800,
      },
    ];

    const snapshot = buildCollaborationObservabilitySnapshot(run, turns);
    expect(snapshot.runId).toBe("run_obs");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.participantCount).toBe(2);
    expect(snapshot.totalAttempts).toBe(3);
    expect(snapshot.completedAttempts).toBe(2);
    expect(snapshot.failedAttempts).toBe(1);
    expect(snapshot.cancelledAttempts).toBe(0);
    expect(snapshot.totalDurationMs).toBe(1500);
    expect(snapshot.perParticipant).toHaveLength(2);
    expect(snapshot.perParticipant[0]!.participantId).toBe("p_arch");
    expect(snapshot.perParticipant[0]!.turnsExecuted).toBe(1);
    expect(snapshot.perParticipant[1]!.participantId).toBe("p_impl");
    expect(snapshot.perParticipant[1]!.turnsExecuted).toBe(2);
  });
});
