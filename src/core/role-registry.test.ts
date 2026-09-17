import { describe, it, expect } from "bun:test";
import {
  BUILTIN_ROLE_IDS,
  type RoleDefinition,
} from "./collaboration-domain";
import { validateRoleDefinition } from "./collaboration-validation";
import {
  BUILTIN_ROLE_DEFINITIONS,
  getBuiltinRoleDefinition,
} from "./builtin-roles";
import {
  RoleRegistry,
  RoleRegistryError,
  createBuiltinRoleRegistry,
} from "./role-registry";

describe("P4.1 RoleRegistry & Builtin Roles", () => {
  // ============================================================
  // 1. Basic Registry Operations
  // ============================================================
  describe("Basic Lifecycle & Registration", () => {
    it("creates empty registry", () => {
      const registry = new RoleRegistry();
      expect(registry.list()).toEqual([]);
      expect(registry.ids()).toEqual([]);
      expect(registry.has("architect")).toBe(false);
      expect(registry.get("architect")).toBeUndefined();
    });

    it("register valid custom role", () => {
      const registry = new RoleRegistry();
      const customRole: RoleDefinition = {
        id: "qa_engineer",
        name: "QA Engineer",
        description: "Focuses on edge case testing and quality assurance.",
        systemInstructions: "Design and execute deterministic test scenarios.",
      };
      registry.register(customRole);

      expect(registry.has("qa_engineer")).toBe(true);
      const retrieved = registry.get("qa_engineer");
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("qa_engineer");
      expect(retrieved?.name).toBe("QA Engineer");
    });

    it("has registered role", () => {
      const registry = new RoleRegistry();
      registry.register({
        id: "researcher",
        name: "Researcher",
        description: "Gathers evidence.",
        systemInstructions: "Investigate and report.",
      });
      expect(registry.has("researcher")).toBe(true);
      expect(registry.has("nonexistent")).toBe(false);
    });

    it("require registered role returns the role", () => {
      const registry = new RoleRegistry();
      registry.register({
        id: "architect",
        name: "Architect",
        description: "Designs system.",
        systemInstructions: "Design interfaces and components.",
      });
      const role = registry.require("architect");
      expect(role.id).toBe("architect");
      expect(role.name).toBe("Architect");
    });

    it("require unknown role throws RoleRegistryError with code role_not_found", () => {
      const registry = new RoleRegistry();
      try {
        registry.require("nonexistent_role");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err instanceof RoleRegistryError).toBe(true);
        const regErr = err as RoleRegistryError;
        expect(regErr.code).toBe("role_not_found");
        expect(regErr.roleId).toBe("nonexistent_role");
      }
    });

    it("duplicate registration throws RoleRegistryError with code duplicate_role", () => {
      const registry = new RoleRegistry();
      const role: RoleDefinition = {
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews code.",
        systemInstructions: "Review code thoroughly.",
      };
      registry.register(role);

      expect(() => registry.register(role)).toThrow(RoleRegistryError);
      try {
        registry.register(role);
      } catch (err) {
        const regErr = err as RoleRegistryError;
        expect(regErr.code).toBe("duplicate_role");
        expect(regErr.roleId).toBe("reviewer");
      }
    });

    it("invalid role registration rejected with code invalid_role_definition", () => {
      const registry = new RoleRegistry();
      const invalidRole = {
        id: "INVALID_UPPERCASE_ROLE",
        name: "",
        description: "",
        systemInstructions: "",
      } as any;

      expect(() => registry.register(invalidRole)).toThrow(RoleRegistryError);
      try {
        registry.register(invalidRole);
      } catch (err) {
        const regErr = err as RoleRegistryError;
        expect(regErr.code).toBe("invalid_role_definition");
      }
    });

    it("constructor rejects duplicate definitions", () => {
      const duplicateDefs: RoleDefinition[] = [
        {
          id: "primary",
          name: "Primary 1",
          description: "Desc 1",
          systemInstructions: "Instructions 1",
        },
        {
          id: "primary",
          name: "Primary 2",
          description: "Desc 2",
          systemInstructions: "Instructions 2",
        },
      ];
      expect(() => new RoleRegistry(duplicateDefs)).toThrow(RoleRegistryError);
    });
  });

  // ============================================================
  // 2. Deterministic Ordering
  // ============================================================
  describe("Deterministic Ordering", () => {
    it("list returns deterministic registration order", () => {
      const registry = new RoleRegistry();
      const order = ["verifier", "architect", "critic"] as const;
      for (const id of order) {
        registry.register({
          id,
          name: `${id} name`,
          description: `${id} desc`,
          systemInstructions: `${id} instructions`,
        });
      }

      const list = registry.list();
      expect(list.map(r => r.id)).toEqual(["verifier", "architect", "critic"]);
    });

    it("ids returns deterministic registration order", () => {
      const registry = new RoleRegistry();
      registry.register({ id: "researcher", name: "R", description: "D", systemInstructions: "I" });
      registry.register({ id: "implementer", name: "I", description: "D", systemInstructions: "I" });
      registry.register({ id: "primary", name: "P", description: "D", systemInstructions: "I" });

      expect(registry.ids()).toEqual(["researcher", "implementer", "primary"]);
    });
  });

  // ============================================================
  // 3. Immutability Guarantees
  // ============================================================
  describe("Immutability Guarantees", () => {
    it("caller cannot mutate returned role", () => {
      const registry = new RoleRegistry();
      registry.register({
        id: "architect",
        name: "Original Name",
        description: "Original Description",
        systemInstructions: "Original Instructions",
      });

      const retrieved = registry.require("architect");
      try {
        (retrieved as any).name = "HACKED_NAME";
      } catch {
        // Strict mode throws TypeError: Cannot assign to read only property
      }

      const fresh = registry.require("architect");
      expect(fresh.name).toBe("Original Name");
    });

    it("caller cannot mutate nested output contract schema", () => {
      const registry = new RoleRegistry();
      registry.register({
        id: "architect",
        name: "Architect",
        description: "Designs system",
        systemInstructions: "Instructions",
        outputContract: {
          type: "json_schema",
          schema: { properties: { summary: { type: "string" } } },
        },
      });

      const retrieved = registry.require("architect");
      try {
        (retrieved.outputContract?.schema as any).properties.summary.type = "MUTATED";
      } catch {
        // Deep freeze throws on mutation
      }

      const fresh = registry.require("architect");
      expect((fresh.outputContract?.schema as any)?.properties?.summary?.type).toBe("string");
    });

    it("caller cannot mutate list into internal state", () => {
      const registry = new RoleRegistry();
      registry.register({
        id: "primary",
        name: "Primary",
        description: "Desc",
        systemInstructions: "Inst",
      });

      const list = registry.list();
      try {
        (list as any).push({
          id: "fake_role",
          name: "Fake",
          description: "Fake",
          systemInstructions: "Fake",
        });
      } catch {
        // Frozen array throws on push
      }

      expect(registry.list().length).toBe(1);
      expect(registry.has("fake_role" as any)).toBe(false);
    });

    it("input mutation isolation: mutating source object after register does not affect registry", () => {
      const registry = new RoleRegistry();
      const mutableRole: RoleDefinition = {
        id: "implementer",
        name: "Original Implementer",
        description: "Original description",
        systemInstructions: "Original instructions",
        outputContract: {
          type: "json_schema",
          schema: { version: 1 },
        },
      };

      registry.register(mutableRole);

      // Mutate the outer object that was passed in
      (mutableRole as any).name = "MUTATED_AFTER_REGISTER";
      if (mutableRole.outputContract?.schema) {
        (mutableRole.outputContract.schema as any).version = 999;
      }

      const retrieved = registry.require("implementer");
      expect(retrieved.name).toBe("Original Implementer");
      expect(retrieved.outputContract?.schema?.version).toBe(1);
    });

    it("output mutation isolation: multiple gets return independent immutable views", () => {
      const registry = createBuiltinRoleRegistry();
      const first = registry.get("architect")!;
      try {
        (first as any).description = "CORRUPTED";
      } catch {}

      const second = registry.get("architect")!;
      expect(second.description).toBe(
        "Decomposes high-level objectives into modular architectural specifications, defining interfaces, invariants, and technical trade-offs.",
      );
    });

    it("two registries do not share mutable state", () => {
      const a = createBuiltinRoleRegistry();
      const b = createBuiltinRoleRegistry();

      const customRole: RoleDefinition = {
        id: "security_auditor",
        name: "Security Auditor",
        description: "Audits security posture.",
        systemInstructions: "Audit code.",
      };

      a.register(customRole);

      expect(a.has("security_auditor")).toBe(true);
      expect(b.has("security_auditor")).toBe(false);
      expect(b.list().length).toBe(7);
      expect(a.list().length).toBe(8);
    });
  });

  // ============================================================
  // 4. Built-in Roles Invariants
  // ============================================================
  describe("Built-in Roles Invariants", () => {
    it("builtin registry contains exactly 7 roles", () => {
      const registry = createBuiltinRoleRegistry();
      expect(registry.list().length).toBe(7);
    });

    it("builtin IDs exactly equal BUILTIN_ROLE_IDS in exact order", () => {
      const registry = createBuiltinRoleRegistry();
      expect(registry.ids()).toEqual(BUILTIN_ROLE_IDS);
      expect(BUILTIN_ROLE_DEFINITIONS.map(d => d.id)).toEqual(BUILTIN_ROLE_IDS as any);
    });

    it("all builtin definitions pass existing validation", () => {
      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        const issues = validateRoleDefinition(def);
        expect(issues).toEqual([]);
      }
    });

    it("all 7 individual built-in roles are accessible via getBuiltinRoleDefinition", () => {
      for (const id of BUILTIN_ROLE_IDS) {
        const def = getBuiltinRoleDefinition(id);
        expect(def.id).toBe(id);
        expect(def.name.length).toBeGreaterThan(0);
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.systemInstructions.length).toBeGreaterThan(0);
      }
    });

    it("no builtin role contains adapter or provider binding", () => {
      // Forbidden implementation-specific tokens
      const forbiddenPatterns = [
        /\bacp\b/i,
        /acp:/i,
        /subprocess-jsonl/i,
        /codex-router/i,
        /\bclaude\b/i,
        /\bantigravity\b/i,
        /\bchatgpt\b/i,
        /\bcodex\b/i,
        /\bopenai\b/i,
        /\banthropic\b/i,
        /\bgoogle\b/i,
        /\bgpt-[0-9]/i,
      ];

      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        const text = `${def.name} ${def.description} ${def.systemInstructions} ${def.expectedInputSummary ?? ""}`;
        for (const pattern of forbiddenPatterns) {
          expect(pattern.test(text)).toBe(false);
        }
      }
    });

    it("Role != Capability: built-in instructions express responsibility and do not grant ambient authority", () => {
      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        // All built-in roles must explicitly remind the agent to operate only through explicitly granted capabilities
        expect(def.systemInstructions.toLowerCase()).toContain("operate only through capabilities explicitly granted by the runtime");

        // Must not contain false promises of unrestricted authority
        expect(def.systemInstructions).not.toContain("you may edit any file");
        expect(def.systemInstructions).not.toContain("you have terminal access");
        expect(def.systemInstructions).not.toContain("full access");
      }
    });

    it("no ambient runtime permissions or config properties in built-in definitions", () => {
      const forbiddenKeys = [
        "permissionMode",
        "command",
        "cwd",
        "adapterType",
        "provider",
        "model",
        "credential",
        "token",
      ];

      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        for (const key of forbiddenKeys) {
          expect((def as any)[key]).toBeUndefined();
        }
      }
    });

    it("built-in role definitions are strictly bounded in prompt size (< 8 KiB)", () => {
      const MAX_SIZE_BYTES = 8192;
      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        const bytes = new TextEncoder().encode(def.systemInstructions).length;
        expect(bytes).toBeLessThan(MAX_SIZE_BYTES);
      }
    });

    it("role definitions remain JSON serializable", () => {
      for (const def of BUILTIN_ROLE_DEFINITIONS) {
        const serialized = JSON.stringify(def);
        const restored = JSON.parse(serialized);
        expect(restored.id).toBe(def.id);
        expect(restored.name).toBe(def.name);
        expect(restored.description).toBe(def.description);
        expect(restored.systemInstructions).toBe(def.systemInstructions);
      }
    });
  });
});
