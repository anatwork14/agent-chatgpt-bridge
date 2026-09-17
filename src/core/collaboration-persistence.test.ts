import { describe, expect, it } from "bun:test";
import {
  InMemoryRoleBasedRunPersistence,
} from "./collaboration-persistence";
import {
  applyRoleBasedRunPatch,
  type RoleBasedCollaborationRun,
  type RoleBasedRunPatch,
  type CollaborationTurnRecord,
  type ParticipantRecord,
  isRoleBasedRunTerminalStatus,
} from "./collaboration-domain";
import { BridgeError } from "./errors";

describe("P4.5.1 Collaboration Persistence & Patch Semantics", () => {
  const baseRun: RoleBasedCollaborationRun = {
    id: "run_test_patch",
    sessionId: "ses_patch",
    objective: "Test patch semantics",
    status: "running",
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
    participantIds: ["part_1", "part_2"],
    participantsById: {},
    turnHistory: [],
    createdAt: "2026-09-17T00:00:00Z",
    startedAt: "2026-09-17T00:00:00Z",
    activeParticipantId: "part_1",
    finalSummary: "Initial summary",
    completedAt: undefined,
  };

  it("applyRoleBasedRunPatch: concrete value overwrites existing field", () => {
    const patch: RoleBasedRunPatch = {
      status: "paused",
      round: 1,
      activeParticipantId: "part_2",
      finalSummary: "Paused for user input",
    };
    const updated = applyRoleBasedRunPatch(baseRun, patch);
    expect(updated.status).toBe("paused");
    expect(updated.round).toBe(1);
    expect(updated.activeParticipantId).toBe("part_2");
    expect(updated.finalSummary).toBe("Paused for user input");
  });

  it("applyRoleBasedRunPatch: null explicitly clears nullable fields", () => {
    const patch: RoleBasedRunPatch = {
      activeParticipantId: null,
      finalSummary: null,
      completedAt: null,
    };
    const updated = applyRoleBasedRunPatch(baseRun, patch);
    expect(updated.activeParticipantId).toBeUndefined();
    expect(updated.finalSummary).toBeUndefined();
    expect(updated.completedAt).toBeUndefined();
  });

  it("applyRoleBasedRunPatch: undefined preserves existing field values", () => {
    const patch: RoleBasedRunPatch = {
      round: 2,
    };
    const updated = applyRoleBasedRunPatch(baseRun, patch);
    expect(updated.round).toBe(2);
    // Preserved:
    expect(updated.status).toBe("running");
    expect(updated.activeParticipantId).toBe("part_1");
    expect(updated.finalSummary).toBe("Initial summary");
  });

  it("InMemoryRoleBasedRunPersistence: enforces terminal state immutability", () => {
    const persistence = new InMemoryRoleBasedRunPersistence();
    persistence.createInitialRun(baseRun, []);

    // Finalize as completed
    persistence.finalizeRun(baseRun.id, {
      status: "completed",
      completedAt: "2026-09-17T00:01:00Z",
      finalSummary: "Workflow complete",
      activeParticipantId: null,
    });

    const terminalRun = persistence.getRun(baseRun.id);
    expect(terminalRun?.status).toBe("completed");
    expect(isRoleBasedRunTerminalStatus(terminalRun!.status)).toBe(true);

    // Attempt to transition completed -> cancelled must throw
    expect(() => {
      persistence.finalizeRun(baseRun.id, {
        status: "cancelled",
        completedAt: "2026-09-17T00:02:00Z",
        finalSummary: "Cancelled late",
      });
    }).toThrow(BridgeError);

    try {
      persistence.finalizeRun(baseRun.id, { status: "cancelled" });
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("invalid_state_transition");
    }

    // Attempt to updateParticipantAndRunTransaction with terminal status change must throw
    const part: ParticipantRecord = {
      id: "part_1",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "idle",
      turnsExecuted: 1,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    };
    expect(() => {
      persistence.updateParticipantAndRunTransaction({
        participant: part,
        runUpdates: {
          id: baseRun.id,
          status: "failed",
        },
      });
    }).toThrow(BridgeError);
  });

  it("InMemoryRoleBasedRunPersistence: getTurns returns recorded turns ordered by turnIndex", () => {
    const persistence = new InMemoryRoleBasedRunPersistence();
    const plans = [
      {
        roleId: "architect" as const,
        participantId: "part_1",
        sequenceIndex: 0,
        adapterId: "acp:claude",
        role: { id: "architect", name: "Architect", description: "desc", systemInstructions: "inst" },
        config: { adapterType: "acp" },
      },
      {
        roleId: "implementer" as const,
        participantId: "part_2",
        sequenceIndex: 1,
        adapterId: "acp:antigravity",
        role: { id: "implementer", name: "Implementer", description: "desc", systemInstructions: "inst" },
        config: { adapterType: "acp" },
      },
    ];

    const part1: ParticipantRecord = {
      id: "part_1",
      roleId: "architect",
      adapterId: "acp:claude",
      status: "idle",
      turnsExecuted: 1,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    };

    const part2: ParticipantRecord = {
      id: "part_2",
      roleId: "implementer",
      adapterId: "acp:antigravity",
      status: "idle",
      turnsExecuted: 1,
      consecutiveFailures: 0,
      createdAt: "2026-09-17T00:00:00Z",
    };

    const runWithParts = {
      ...baseRun,
      participantsById: { part_1: part1, part_2: part2 },
    };

    persistence.createInitialRun(runWithParts, plans as any);

    const turn1: CollaborationTurnRecord = {
      id: "turn_1",
      runId: baseRun.id,
      round: 0,
      turnIndex: 0,
      participantId: "part_1",
      roleId: "architect",
      status: "completed",
      inputSummary: "Step 1",
      decision: { type: "message", content: "Plan V1" },
      startedAt: "2026-09-17T00:00:01Z",
      completedAt: "2026-09-17T00:00:02Z",
    };

    const turn2: CollaborationTurnRecord = {
      id: "turn_2",
      runId: baseRun.id,
      round: 0,
      turnIndex: 1,
      participantId: "part_2",
      roleId: "implementer",
      status: "completed",
      inputSummary: "Step 2",
      decision: { type: "done", summary: "Done V1" },
      startedAt: "2026-09-17T00:00:03Z",
      completedAt: "2026-09-17T00:00:04Z",
    };

    persistence.recordTurnTransaction({
      turn: turn1,
      participant: part1,
      runUpdates: { id: baseRun.id, round: 0 },
    });

    persistence.recordTurnTransaction({
      turn: turn2,
      participant: part2,
      runUpdates: { id: baseRun.id, round: 0, status: "completed" },
    });

    const turns = persistence.getTurns(baseRun.id);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).toBe("turn_1");
    expect(turns[0]?.turnIndex).toBe(0);
    expect(turns[1]?.id).toBe("turn_2");
    expect(turns[1]?.turnIndex).toBe(1);
  });
});
