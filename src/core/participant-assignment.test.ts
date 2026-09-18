import { describe, expect, it } from "bun:test";
import { RoleRegistry } from "./role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import {
  type CollaborationConfig,
  type RoleDefinition,
} from "./collaboration-domain";
import {
  normalizeRoleAssignments,
  createParticipantAssignmentPlans,
  createInitialParticipantRecords,
} from "./participant-assignment";
import { CollaborationValidationError } from "./collaboration-validation";

function createStandardRegistry(): RoleRegistry {
  return new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);
}

describe("P4.2 Participant Assignment & Canonical Planning", () => {
  describe("Assignment Normalization", () => {
    it("map assignments normalized", () => {
      const mapForm = {
        architect: { adapterType: "acp:claude" },
        implementer: { adapterType: "acp:antigravity" },
      };
      const normalized = normalizeRoleAssignments(mapForm);
      expect(normalized).toHaveLength(2);
      expect(normalized).toEqual([
        {
          roleId: "architect",
          participantConfig: { adapterType: "acp:claude" },
        },
        {
          roleId: "implementer",
          participantConfig: { adapterType: "acp:antigravity" },
        },
      ]);
    });

    it("array assignments normalized", () => {
      const arrayForm = [
        {
          roleId: "architect" as const,
          participantConfig: { adapterType: "acp:claude" },
        },
        {
          roleId: "reviewer" as const,
          participantConfig: { adapterType: "acp:claude" },
        },
      ];
      const normalized = normalizeRoleAssignments(arrayForm);
      expect(normalized).toHaveLength(2);
      expect(normalized[0]?.roleId).toBe("architect");
      expect(normalized[1]?.roleId).toBe("reviewer");
    });

    it("duplicate role in array assignments rejected", () => {
      const duplicateForm = [
        {
          roleId: "architect" as const,
          participantConfig: { adapterType: "acp:claude" },
        },
        {
          roleId: "architect" as const,
          participantConfig: { adapterType: "acp:claude" },
        },
      ];
      expect(() => normalizeRoleAssignments(duplicateForm)).toThrow("Duplicate role assignment for role 'architect'");
    });

    it("invalid roles container rejected", () => {
      expect(() => normalizeRoleAssignments(null as any)).toThrow();
      expect(() => normalizeRoleAssignments(undefined as any)).toThrow();
      expect(() => normalizeRoleAssignments("not_an_object" as any)).toThrow();
    });
  });

  describe("Canonical Planning & Invariants", () => {
    it("ordering follows policy.roleSequence", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Test sequencing order",
        policy: {
          roleSequence: ["implementer", "architect", "verifier"],
          loopMode: "once",
          terminalRoles: ["verifier"],
        },
        roles: {
          verifier: { adapterType: "subprocess-jsonl", command: ["./verify.sh"] },
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans).toHaveLength(3);
      expect(plans[0]?.roleId).toBe("implementer");
      expect(plans[0]?.sequenceIndex).toBe(0);
      expect(plans[1]?.roleId).toBe("architect");
      expect(plans[1]?.sequenceIndex).toBe(1);
      expect(plans[2]?.roleId).toBe("verifier");
      expect(plans[2]?.sequenceIndex).toBe(2);
    });

    it("input object key order ignored", () => {
      const registry = createStandardRegistry();

      const config1: CollaborationConfig = {
        objective: "Test ordering invariance 1",
        policy: {
          roleSequence: ["architect", "implementer", "reviewer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["reviewer"],
        },
        roles: {
          reviewer: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
          architect: { adapterType: "acp:claude" },
        },
      };

      const config2: CollaborationConfig = {
        objective: "Test ordering invariance 2",
        policy: {
          roleSequence: ["architect", "implementer", "reviewer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["reviewer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          reviewer: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
        },
      };

      let seq1 = 0;
      let seq2 = 0;
      const plans1 = createParticipantAssignmentPlans(config1, registry, {
        idFactory: () => `part_${++seq1}`,
      });
      const plans2 = createParticipantAssignmentPlans(config2, registry, {
        idFactory: () => `part_${++seq2}`,
      });

      expect(plans1.map(p => p.roleId)).toEqual(plans2.map(p => p.roleId));
      expect(plans1.map(p => p.adapterId)).toEqual(plans2.map(p => p.adapterId));
      expect(plans1.map(p => p.sequenceIndex)).toEqual(plans2.map(p => p.sequenceIndex));
    });

    it("custom registered role accepted", () => {
      const registry = createStandardRegistry();
      const customRole: RoleDefinition = {
        id: "security_auditor",
        name: "Security Auditor",
        description: "Audits AST for dangerous calls",
        systemInstructions: "Analyze code for injection vulnerabilities.",
      };
      registry.register(customRole);

      const config: CollaborationConfig = {
        objective: "Audit codebase",
        policy: {
          roleSequence: ["security_auditor"],
          loopMode: "once",
          terminalRoles: ["security_auditor"],
        },
        roles: {
          security_auditor: { adapterType: "acp:claude" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.roleId).toBe("security_auditor");
      expect(plans[0]?.role.name).toBe("Security Auditor");
      expect(plans[0]?.adapterId).toBe("acp:claude");
    });

    it("unknown role rejected", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Unknown role test",
        policy: {
          roleSequence: ["nonexistent_role" as any],
          loopMode: "once",
          terminalRoles: ["nonexistent_role" as any],
        },
        roles: {
          nonexistent_role: { adapterType: "acp:claude" },
        } as any,
      };

      expect(() => createParticipantAssignmentPlans(config, registry)).toThrow(
        CollaborationValidationError,
      );
    });

    it("missing assignment rejected", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Missing role assignment test",
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          // implementer is missing
        },
      };

      expect(() => createParticipantAssignmentPlans(config, registry)).toThrow(
        CollaborationValidationError,
      );
    });

    it("participant IDs unique", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Unique IDs test",
        policy: {
          roleSequence: ["architect", "implementer", "reviewer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["reviewer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
          reviewer: { adapterType: "acp:claude" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      const ids = plans.map(p => p.participantId);
      expect(ids).toHaveLength(3);
      for (const id of ids) {
        expect(id.startsWith("part_")).toBe(true);
      }
      expect(new Set(ids).size).toBe(3);
    });

    it("injected ID generator deterministic", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Deterministic ID test",
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
        },
      };

      let counter = 100;
      const plans = createParticipantAssignmentPlans(config, registry, {
        idFactory: () => `part_det_${counter++}`,
      });

      expect(plans[0]?.participantId).toBe("part_det_100");
      expect(plans[1]?.participantId).toBe("part_det_101");
    });

    it("adapterId preserves acp:claude", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Preserve claude adapter ID",
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans[0]?.adapterId).toBe("acp:claude");
    });

    it("adapterId preserves acp:antigravity", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Preserve antigravity adapter ID",
        policy: {
          roleSequence: ["implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          implementer: { adapterType: "acp:antigravity" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans[0]?.adapterId).toBe("acp:antigravity");
    });

    it("two participants using same adapter profile remain distinct participants", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Distinct participants test",
        policy: {
          roleSequence: ["architect", "reviewer"],
          loopMode: "repeat_until_done",
          terminalRoles: ["reviewer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          reviewer: { adapterType: "acp:claude" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans).toHaveLength(2);
      expect(plans[0]?.participantId).not.toBe(plans[1]?.participantId);
      expect(plans[0]?.roleId).toBe("architect");
      expect(plans[1]?.roleId).toBe("reviewer");
      expect(plans[0]?.adapterId).toBe("acp:claude");
      expect(plans[1]?.adapterId).toBe("acp:claude");
    });
  });

  describe("Initial Participant Records", () => {
    it("ParticipantRecord starts pending", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Pending status test",
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
        },
      };

      const fixedTime = "2026-09-17T12:00:00.000Z";
      const plans = createParticipantAssignmentPlans(config, registry);
      const records = createInitialParticipantRecords(plans, {
        clock: () => fixedTime,
      });

      expect(records.participantIds).toEqual(plans.map(p => p.participantId));
      for (const plan of plans) {
        const record = records.participantsById[plan.participantId];
        expect(record).toBeDefined();
        expect(record?.id).toBe(plan.participantId);
        expect(record?.roleId).toBe(plan.roleId);
        expect(record?.adapterId).toBe(plan.adapterId);
        expect(record?.status).toBe("pending");
        expect(record?.turnsExecuted).toBe(0);
        expect(record?.consecutiveFailures).toBe(0);
        expect(record?.createdAt).toBe(fixedTime);
        expect(record?.lastActiveAt).toBeUndefined();
      }
    });

    it("runtime objects are not serialized into ParticipantRecord", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Serialization invariant test",
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      const records = createInitialParticipantRecords(plans);
      const record = records.participantsById[plans[0]!.participantId]!;

      // Verify strict JSON roundtrip without loss or undefined properties
      const serialized = JSON.stringify(record);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(record);

      // Verify no runtime handles exist on the record
      const allowedKeys = new Set([
        "id",
        "roleId",
        "adapterId",
        "status",
        "turnsExecuted",
        "consecutiveFailures",
        "createdAt",
        "lastActiveAt",
      ]);
      for (const key of Object.keys(record)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });
});
