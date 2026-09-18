import { describe, it, expect } from "bun:test";
import {
  BUILTIN_ROLE_IDS,
  P4_LIMITS,
  P4_DEFAULT_BUDGET,
  type RoleId,
  type RoleDefinition,
  type RoleAssignment,
  type RoleBasedRunBudget,
  type RunPolicy,
  type ParticipantRecord,
  type CollaborationTurnRecord,
  type RoleBasedCollaborationRun,
  type CollaborationConfig,
} from "./collaboration-domain";
import {
  ROLE_ID_REGEX,
  isValidRoleId,
  validateRoleDefinition,
  validateRoleDefinitions,
  validateRunBudget,
  validateRunPolicy,
  validateRoleAssignments,
  validateCollaborationConfig,
  assertValidCollaborationConfig,
  CollaborationValidationError,
} from "./collaboration-validation";

describe("P4 Collaboration Domain & Validation", () => {
  // ============================================================
  // 1. Role ID and Builtin Role Invariants
  // ============================================================
  describe("Role IDs & Builtins", () => {
    it("builtin role list is stable and contains expected 7 roles", () => {
      expect(BUILTIN_ROLE_IDS).toEqual([
        "primary",
        "architect",
        "researcher",
        "implementer",
        "critic",
        "reviewer",
        "verifier",
      ]);
      for (const id of BUILTIN_ROLE_IDS) {
        expect(isValidRoleId(id)).toBe(true);
      }
    });

    it("custom valid role accepted", () => {
      expect(isValidRoleId("security_auditor")).toBe(true);
      expect(isValidRoleId("qa-lead")).toBe(true);
      expect(isValidRoleId("lead_developer_1")).toBe(true);
      expect(isValidRoleId("a")).toBe(true);
      expect(isValidRoleId("a".repeat(64))).toBe(true);
    });

    it("invalid role ID rejected", () => {
      expect(isValidRoleId("")).toBe(false);
      expect(isValidRoleId("Architect")).toBe(false); // uppercase
      expect(isValidRoleId("role with spaces")).toBe(false);
      expect(isValidRoleId("../../foo")).toBe(false);
      expect(isValidRoleId("123lead")).toBe(false); // starts with digit
      expect(isValidRoleId("-lead")).toBe(false); // starts with hyphen
      expect(isValidRoleId("_lead")).toBe(false); // starts with underscore
      expect(isValidRoleId("a".repeat(65))).toBe(false); // > 64 chars
      expect(isValidRoleId(null)).toBe(false);
      expect(isValidRoleId(undefined)).toBe(false);
      expect(isValidRoleId(123)).toBe(false);
    });
  });

  // ============================================================
  // 2. Role Definitions Validation
  // ============================================================
  describe("Role Definition Validation", () => {
    it("valid role definition is accepted", () => {
      const def: RoleDefinition = {
        id: "architect",
        name: "System Architect",
        description: "Decomposes objectives and produces plans",
        systemInstructions: "You are the system architect. Output high-level specs.",
        expectedInputSummary: "Objective and repository constraints",
        outputContract: { type: "text" },
      };
      const issues = validateRoleDefinition(def);
      expect(issues).toEqual([]);
    });

    it("invalid role definition fields produce structured issues", () => {
      const issues = validateRoleDefinition({
        id: "INVALID_ID",
        name: "",
        description: "   ",
        systemInstructions: "",
        outputContract: { type: "invalid" as any },
      });
      const codes = issues.map(i => i.code);
      expect(codes).toContain("invalid_role_id");
      expect(codes).toContain("invalid_role_name");
      expect(codes).toContain("invalid_role_description");
      expect(codes).toContain("invalid_role_system_instructions");
      expect(codes).toContain("invalid_output_contract");
    });

    it("duplicate role ID rejected across definitions", () => {
      const roles: RoleDefinition[] = [
        {
          id: "architect",
          name: "Architect 1",
          description: "Primary architect",
          systemInstructions: "Do architecture",
        },
        {
          id: "architect",
          name: "Architect 2",
          description: "Duplicate architect",
          systemInstructions: "Do duplicate architecture",
        },
      ];
      const issues = validateRoleDefinitions(roles);
      expect(issues.some(i => i.code === "duplicate_role")).toBe(true);
    });
  });

  // ============================================================
  // 3. Run Budget Validation & Hard Limits
  // ============================================================
  describe("Budget Invariants & Hard Safety Limits", () => {
    it("default budget passes validation", () => {
      const issues = validateRunBudget(P4_DEFAULT_BUDGET);
      expect(issues).toEqual([]);
    });

    it("maxTurns zero or negative rejected", () => {
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxTurns: 0 }).some(i => i.code === "invalid_budget")).toBe(true);
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxTurns: -5 }).some(i => i.code === "invalid_budget")).toBe(true);
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxTurns: 3.5 }).some(i => i.code === "invalid_budget")).toBe(true);
    });

    it("maxTurns hard limit rejected", () => {
      const issues = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxTurns: P4_LIMITS.maxTurns + 1 });
      expect(issues.some(i => i.code === "budget_limit_exceeded")).toBe(true);
    });

    it("maxParticipants zero or negative rejected", () => {
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxParticipants: 0 }).some(i => i.code === "invalid_budget")).toBe(true);
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxParticipants: -1 }).some(i => i.code === "invalid_budget")).toBe(true);
    });

    it("maxParticipants hard limit rejected", () => {
      const issues = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxParticipants: P4_LIMITS.maxParticipants + 1 });
      expect(issues.some(i => i.code === "budget_limit_exceeded")).toBe(true);
    });

    it("maxParallelTurns != 1 rejected (P4 sequential turn guarantee)", () => {
      const issuesZero = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxParallelTurns: 0 as any });
      expect(issuesZero.some(i => i.code === "invalid_parallelism")).toBe(true);

      const issuesTwo = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxParallelTurns: 2 as any });
      expect(issuesTwo.some(i => i.code === "invalid_parallelism")).toBe(true);
    });

    it("negative retry count rejected", () => {
      const issues = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxRetriesPerParticipant: -1 });
      expect(issues.some(i => i.code === "invalid_budget")).toBe(true);
    });

    it("retry count over hard max rejected", () => {
      const issues = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxRetriesPerParticipant: P4_LIMITS.maxRetriesPerParticipant + 1 });
      expect(issues.some(i => i.code === "budget_limit_exceeded")).toBe(true);
    });

    it("zero or negative wall-clock rejected", () => {
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxWallClockMs: 0 }).some(i => i.code === "invalid_budget")).toBe(true);
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxWallClockMs: -100 }).some(i => i.code === "invalid_budget")).toBe(true);
      expect(validateRunBudget({ ...P4_DEFAULT_BUDGET, maxWallClockMs: NaN }).some(i => i.code === "invalid_budget")).toBe(true);
    });

    it("wall-clock over hard max rejected", () => {
      const issues = validateRunBudget({ ...P4_DEFAULT_BUDGET, maxWallClockMs: P4_LIMITS.maxWallClockMs + 1000 });
      expect(issues.some(i => i.code === "budget_limit_exceeded")).toBe(true);
    });
  });

  // ============================================================
  // 4. Run Policy Invariants
  // ============================================================
  describe("Run Policy Invariants", () => {
    it("empty role sequence rejected", () => {
      const policy: RunPolicy = {
        roleSequence: [],
        loopMode: "once",
        terminalRoles: ["reviewer"],
      };
      const issues = validateRunPolicy(policy);
      expect(issues.some(i => i.code === "empty_role_sequence")).toBe(true);
    });

    it("unknown scheduled role rejected when known roles provided", () => {
      const policy: RunPolicy = {
        roleSequence: ["architect", "unknown_role_xyz"],
        loopMode: "once",
        terminalRoles: ["architect"],
      };
      const known = new Set(["architect", "reviewer"]);
      const issues = validateRunPolicy(policy, known);
      expect(issues.some(i => i.code === "unknown_role")).toBe(true);
    });

    it("no terminal role rejected", () => {
      const policy: RunPolicy = {
        roleSequence: ["architect", "reviewer"],
        loopMode: "once",
        terminalRoles: [],
      };
      const issues = validateRunPolicy(policy);
      expect(issues.some(i => i.code === "missing_terminal_role")).toBe(true);
    });

    it("terminal role outside sequence rejected", () => {
      const policy: RunPolicy = {
        roleSequence: ["architect", "implementer"],
        loopMode: "once",
        terminalRoles: ["reviewer"], // reviewer not in sequence
      };
      const issues = validateRunPolicy(policy);
      expect(issues.some(i => i.code === "terminal_role_not_scheduled")).toBe(true);
    });

    it("valid terminal role accepted", () => {
      const policy: RunPolicy = {
        roleSequence: ["architect", "implementer", "reviewer"],
        loopMode: "repeat_until_done",
        terminalRoles: ["reviewer"],
      };
      const issues = validateRunPolicy(policy);
      expect(issues).toEqual([]);
    });

    it("invalid loop mode rejected", () => {
      const policy = {
        roleSequence: ["architect"],
        loopMode: "unbounded_loop" as any,
        terminalRoles: ["architect"],
      };
      const issues = validateRunPolicy(policy);
      expect(issues.some(i => i.code === "invalid_loop_mode")).toBe(true);
    });
  });

  // ============================================================
  // 5. Role Assignments Validation
  // ============================================================
  describe("Role Assignments Invariants", () => {
    it("missing assignment for scheduled role rejected", () => {
      const assignments: RoleAssignment[] = [
        {
          roleId: "architect",
          participantConfig: { adapterType: "acp:claude" },
        },
      ];
      const scheduled = new Set(["architect", "implementer"]);
      const issues = validateRoleAssignments(assignments, undefined, scheduled);
      expect(issues.some(i => i.code === "missing_assignment")).toBe(true);
    });

    it("unknown assignment role rejected when known roles provided", () => {
      const assignments: RoleAssignment[] = [
        {
          roleId: "nonexistent_role",
          participantConfig: { adapterType: "acp:claude" },
        },
      ];
      const known = new Set(["architect"]);
      const issues = validateRoleAssignments(assignments, known);
      expect(issues.some(i => i.code === "unknown_assignment_role")).toBe(true);
    });

    it("duplicate assignment for same role rejected", () => {
      const assignments: RoleAssignment[] = [
        {
          roleId: "architect",
          participantConfig: { adapterType: "acp:claude" },
        },
        {
          roleId: "architect",
          participantConfig: { adapterType: "acp:claude" },
        },
      ];
      const issues = validateRoleAssignments(assignments);
      expect(issues.some(i => i.code === "duplicate_role_assignment")).toBe(true);
    });

    it("invalid participant config missing adapterType rejected", () => {
      const assignments = [
        {
          roleId: "architect",
          participantConfig: { adapterType: "" },
        },
      ];
      const issues = validateRoleAssignments(assignments);
      expect(issues.some(i => i.code === "invalid_adapter_type")).toBe(true);
    });
  });

  // ============================================================
  // 6. Aggregate CollaborationConfig & Cross-field Validation
  // ============================================================
  describe("Aggregate CollaborationConfig Validation", () => {
    it("valid 3-role configuration accepted (Architect, Implementer, Reviewer)", () => {
      const config: CollaborationConfig = {
        objective: "Add CSRF double-submit cookie verification to REST auth gateway",
        policy: {
          roleSequence: ["architect", "implementer", "reviewer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["reviewer"],
        },
        roles: {
          architect: {
            adapterType: "acp:claude",
            config: { permissionMode: "allow_readonly" },
          },
          implementer: {
            adapterType: "acp:antigravity",
            config: { permissionMode: "deny" },
          },
          reviewer: {
            adapterType: "acp:claude",
            config: { permissionMode: "allow_readonly" },
          },
        },
        budget: {
          maxTurns: 25,
          maxParticipants: 4,
          maxWallClockMs: 1800000,
        },
      };

      const issues = validateCollaborationConfig(config);
      expect(issues).toEqual([]);
      expect(() => assertValidCollaborationConfig(config)).not.toThrow();
    });

    it("participant count over budget rejected", () => {
      const config: CollaborationConfig = {
        objective: "Perform full refactor",
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
        },
        budget: {
          maxParticipants: 1, // Only 1 participant allowed, but 2 configured
        },
      };

      const issues = validateCollaborationConfig(config);
      expect(issues.some(i => i.code === "participant_count_over_budget")).toBe(true);
      expect(() => assertValidCollaborationConfig(config)).toThrow(CollaborationValidationError);
    });

    it("empty objective rejected", () => {
      const config: CollaborationConfig = {
        objective: "   ",
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
        },
      };

      const issues = validateCollaborationConfig(config);
      expect(issues.some(i => i.code === "invalid_objective")).toBe(true);
    });
  });

  // ============================================================
  // 7. Security Invariant: Role != Capability
  // ============================================================
  describe("Security Invariant: Role != Capability", () => {
    it("implementer with permissionMode deny is perfectly valid", () => {
      const config: CollaborationConfig = {
        objective: "Generate code proposal without filesystem access",
        policy: {
          roleSequence: ["implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          implementer: {
            adapterType: "acp:antigravity",
            config: { permissionMode: "deny" },
          },
        },
      };
      const issues = validateCollaborationConfig(config);
      expect(issues).toEqual([]);
    });

    it("architect with write-capable or custom command is not rejected by role validation", () => {
      const config: CollaborationConfig = {
        objective: "Architect exploring workspace with custom CLI tool",
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: {
            adapterType: "subprocess-jsonl",
            command: ["./custom-tool", "--write-scaffold"],
            config: { permissionMode: "allow_write" },
          },
        },
      };
      const issues = validateCollaborationConfig(config);
      // Pure validation must NOT infer or restrict capability based on role identity
      expect(issues).toEqual([]);
    });
  });

  // ============================================================
  // 8. Serialization & Data Isolation Test
  // ============================================================
  describe("Serializable Domain Records Invariant", () => {
    it("RoleBasedCollaborationRun and participant records are strictly JSON serializable", () => {
      const participant: ParticipantRecord = {
        id: "part_01",
        roleId: "architect",
        adapterId: "acp:claude",
        status: "ready",
        turnsExecuted: 0,
        consecutiveFailures: 0,
        createdAt: new Date().toISOString(),
      };

      const turn: CollaborationTurnRecord = {
        id: "cturn_01",
        runId: "crun_01",
        round: 0,
        turnIndex: 0,
        participantId: "part_01",
        roleId: "architect",
        status: "completed",
        inputSummary: "Draft architecture",
        decision: {
          type: "message",
          content: "Architecture drafted",
        },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 450,
      };

      const run: RoleBasedCollaborationRun = {
        id: "crun_01",
        sessionId: "ses_01",
        objective: "Implement resilient JWT refresh token rotation",
        status: "running",
        round: 1,
        budget: P4_DEFAULT_BUDGET,
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["implementer"],
        },
        participantIds: [participant.id],
        participantsById: {
          [participant.id]: participant,
        },
        activeParticipantId: participant.id,
        turnHistory: [turn.id],
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };

      const serialized = JSON.stringify(run);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.id).toBe(run.id);
      expect(deserialized.participantIds).toEqual(["part_01"]);
      expect(deserialized.participantsById.part_01.roleId).toBe("architect");
      expect(deserialized.budget.maxParallelTurns).toBe(1);

      // Verify no functions, live handles, or undefined artifacts exist
      for (const key of Object.keys(deserialized)) {
        expect(typeof (deserialized as any)[key]).not.toBe("function");
      }
      expect((deserialized.participantsById.part_01 as any).adapter).toBeUndefined();
      expect((deserialized as any).abortController).toBeUndefined();
    });
  });
});
