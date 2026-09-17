import { describe, expect, it } from "bun:test";
import { RoleRegistry } from "../core/role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "../core/builtin-roles";
import {
  type CollaborationConfig,
  type ParticipantConfig,
} from "../core/collaboration-domain";
import { createParticipantAssignmentPlans } from "../core/participant-assignment";
import {
  preflightParticipant,
  createParticipantAdapter,
  bindParticipant,
  prepareParticipants,
  defaultExecutableLocator,
  ParticipantPreflightError,
  type ExecutableLocator,
} from "./participant-factory";
import { AcpAgentAdapter } from "./acp/adapter";
import { SubprocessJsonlAdapter } from "./subprocess-jsonl";
import { RunController } from "../core/run-controller";
import { BridgeError } from "../core/errors";
import { InMemoryRoleBasedRunPersistence } from "../core/collaboration-persistence";
import type { ExternalAgentAdapter, AgentDecision } from "../core/domain";

function createStandardRegistry(): RoleRegistry {
  return new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);
}

// Deterministic mock locator: maps known binaries to simulated filesystem paths
const fakeLocator: ExecutableLocator = (command: string) => {
  const table: Record<string, string> = {
    "claude-agent-acp": "/usr/local/bin/claude-agent-acp",
    "agy-acp": "/opt/antigravity/bin/agy-acp",
    "agent": "/usr/local/bin/agent",
    "gemini": "/usr/local/bin/gemini",
    "./tools/verify.sh": "/workspace/tools/verify.sh",
    "/bin/sh": "/bin/sh",
  };
  return table[command];
};

describe("P4.2 Participant Factory & Adapter Binding", () => {
  describe("Preflight Validation (Non-Spawning)", () => {
    it("acp:claude resolves existing ACP profile", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.resolvedExecutable).toBe("/usr/local/bin/claude-agent-acp");
      expect(result.command).toEqual(["claude-agent-acp"]);
    });

    // Critical Antigravity regression test:
    // acp:antigravity MUST resolve through the existing profile to agy-acp (NOT agy --acp)
    it("acp:antigravity resolves through existing profile to agy-acp", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:antigravity",
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.resolvedExecutable).toBe("/opt/antigravity/bin/agy-acp");
      expect(result.command).toEqual(["agy-acp"]);
      // Explicit negative assertion: must NOT be "agy --acp"
      expect(result.command).not.toContain("--acp");
      expect(result.command[0]).toBe("agy-acp");
    });

    it("preflight known executable PASS", () => {
      const config: ParticipantConfig = {
        adapterType: "subprocess-jsonl",
        command: ["/bin/sh", "-c", "exit 0"],
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(true);
      expect(result.resolvedExecutable).toBe("/bin/sh");
      expect(result.command).toEqual(["/bin/sh", "-c", "exit 0"]);
    });

    it("preflight missing executable FAIL", () => {
      const config: ParticipantConfig = {
        adapterType: "subprocess-jsonl",
        command: ["nonexistent-binary-12345"],
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe("executable_not_found");
    });

    it("custom ACP requires command", () => {
      const missingCmdConfig: ParticipantConfig = {
        adapterType: "acp",
      };
      const failResult = preflightParticipant(missingCmdConfig, fakeLocator);
      expect(failResult.ok).toBe(false);
      expect(failResult.issues[0]?.code).toBe("missing_acp_command");

      const validCustomConfig: ParticipantConfig = {
        adapterType: "acp",
        command: ["claude-agent-acp"],
      };
      const passResult = preflightParticipant(validCustomConfig, fakeLocator);
      expect(passResult.ok).toBe(true);
      expect(passResult.resolvedExecutable).toBe("/usr/local/bin/claude-agent-acp");
    });

    it("subprocess-jsonl requires command", () => {
      const missingCmdConfig: ParticipantConfig = {
        adapterType: "subprocess-jsonl",
      };
      const result = preflightParticipant(missingCmdConfig, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("missing_subprocess_command");
    });

    it("known profile + command override rejected", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
        command: ["custom-override-command"],
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      const overrideIssue = result.issues.find(i => i.code === "ambiguous_acp_command_override");
      expect(overrideIssue).toBeDefined();
    });

    it("unknown adapter type rejected (fail-closed)", () => {
      const config: ParticipantConfig = {
        adapterType: "unsupported_proto",
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("unsupported_adapter_type");
    });

    it("unknown ACP profile rejected", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:nonexistent_model",
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("unknown_acp_profile");
    });

    it("subprocess-jsonl with permissionMode rejected", () => {
      const config: ParticipantConfig = {
        adapterType: "subprocess-jsonl",
        command: ["/bin/sh"],
        config: { permissionMode: "deny" },
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.code === "unsupported_config_field")).toBe(true);
    });

    it("invalid permissionMode on ACP rejected", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
        config: { permissionMode: "invalid_mode_here" },
      };
      const result = preflightParticipant(config, fakeLocator);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.code === "invalid_permission_mode")).toBe(true);
    });

    it("no implicit fallback when binary is missing", () => {
      const locatorStrict: ExecutableLocator = () => undefined;
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
      };
      const result = preflightParticipant(config, locatorStrict);
      expect(result.ok).toBe(false);
      expect(result.resolvedExecutable).toBeUndefined();
      // Must not fall back to another adapter or shell
      expect(result.issues[0]?.code).toBe("executable_not_found");
    });
  });

  describe("Adapter Factory & Runtime Binding", () => {
    it("factory construction does not spawn child process", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
        config: { permissionMode: "deny" },
      };

      // Constructing adapter must not trigger any process spawn
      const adapter = createParticipantAdapter(config);
      expect(adapter).toBeInstanceOf(AcpAgentAdapter);
      // Adapter is constructed, but child process handle is undefined before initialize/next
      expect((adapter as any).child).toBeUndefined();
    });

    it("creates SubprocessJsonlAdapter without spawning", () => {
      const config: ParticipantConfig = {
        adapterType: "subprocess-jsonl",
        command: ["/bin/sh", "-c", "echo hello"],
      };

      const adapter = createParticipantAdapter(config);
      expect(adapter).toBeInstanceOf(SubprocessJsonlAdapter);
      expect(adapter.id).toBe("subprocess-jsonl");
    });

    it("unsupported adapter throws BridgeError on factory instantiation", () => {
      const config: ParticipantConfig = {
        adapterType: "unsupported_xyz",
      };
      expect(() => createParticipantAdapter(config)).toThrow("Unsupported adapter type 'unsupported_xyz'");
    });

    // Critical Identity Regression Test:
    // Even though adapter.id is "acp", runtime.adapterId and ParticipantRecord.adapterId MUST be "acp:claude"
    it("critical identity preservation: adapterId preserves acp:claude provenance", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Identity test",
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: {
            adapterType: "acp:claude",
            config: { permissionMode: "allow_readonly" },
          },
        },
      };

      const plans = createParticipantAssignmentPlans(config, registry);
      expect(plans[0]?.adapterId).toBe("acp:claude");

      const runtime = bindParticipant(plans[0]!);
      // Crucial assertion: adapter.id is generic ("acp")
      expect(runtime.adapter.id).toBe("acp");
      // But runtime.adapterId retains full configured provenance
      expect(runtime.adapterId).toBe("acp:claude");
      expect(runtime.roleId).toBe("architect");
      expect(runtime.participantId).toBe(plans[0]!.participantId);
    });

    it("two participants using same adapter profile remain distinct instances", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Distinct instance test",
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
      const runtime1 = bindParticipant(plans[0]!);
      const runtime2 = bindParticipant(plans[1]!);

      expect(runtime1.participantId).not.toBe(runtime2.participantId);
      expect(runtime1.adapter).not.toBe(runtime2.adapter);
    });

    it("permissionMode flows unchanged into ACP adapter options", () => {
      const config: ParticipantConfig = {
        adapterType: "acp:claude",
        config: { permissionMode: "deny" },
      };

      const adapter = createParticipantAdapter(config);
      expect((adapter as any).options.permissionMode).toBe("deny");
    });

    it("bindParticipant produces runtime with mutable adapter allowing recreation without throwing in strict mode", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Adapter recreation test",
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
      const runtime = bindParticipant(plans[0]!);

      const initialAdapter = runtime.adapter;
      expect(runtime.recreateAdapter).toBeDefined();

      // In strict mode / sealed object, assigning to runtime.adapter must succeed without error
      expect(() => {
        runtime.adapter = runtime.recreateAdapter!();
      }).not.toThrow();

      expect(runtime.adapter).not.toBe(initialAdapter);
      expect(runtime.adapter).toBeInstanceOf(AcpAgentAdapter);
    });

    it("production-shaped adapter recreation through real factory and RunController", async () => {
      class FakeRunStore {
        private readonly runs = new Map<string, any>();
        create(run: any) { this.runs.set(run.id, { ...run }); }
        get(id: string) { return this.runs.get(id) ?? null; }
        update(id: string, patch: any) {
          const cur = this.runs.get(id);
          if (cur) Object.assign(cur, patch);
        }
      }

      class FakeSessionManager {
        async get(id: string) {
          return { id, status: "active", turns: [], createdAt: new Date().toISOString() };
        }
        async cancel() { return true; }
      }

      class FakeAuditStore {
        public readonly events: any[] = [];
        log(event: any) { this.events.push(event); }
      }

      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Production-shaped recreation test",
        budget: { maxRetriesPerParticipant: 2 },
        policy: {
          roleSequence: ["architect"],
          loopMode: "once",
          terminalRoles: ["architect"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
        },
      };

      let instancesCreated = 0;
      let adapter1Closed = false;
      let adapter2Initialized = false;

      class TestMockAdapter implements ExternalAgentAdapter {
        public readonly id: string;
        public readonly instanceNum: number;
        public closed = false;
        public initialized = false;

        constructor(instanceNum: number) {
          this.instanceNum = instanceNum;
          this.id = `mock-adapter-${instanceNum}`;
        }

        async initialize(): Promise<void> {
          this.initialized = true;
          if (this.instanceNum === 2) {
            adapter2Initialized = true;
          }
        }

        async next(): Promise<AgentDecision> {
          if (this.instanceNum === 1) {
            throw new BridgeError("agent_adapter_failed", "Process crash on instance 1", true);
          }
          return { type: "done", summary: "Instance 2 succeeded" };
        }

        async close(): Promise<void> {
          this.closed = true;
          if (this.instanceNum === 1) {
            adapter1Closed = true;
          }
        }
      }

      // Use real prepareParticipants with custom factory returning new TestMockAdapter instances
      const prepared = prepareParticipants(config, registry, {
        locator: fakeLocator,
        factory: (_cfg) => {
          instancesCreated++;
          return new TestMockAdapter(instancesCreated);
        },
      });

      const initialRuntime = prepared.runtimes[0]!;
      const initialAdapter = initialRuntime.adapter as TestMockAdapter;
      expect(initialAdapter.instanceNum).toBe(1);
      expect(Object.isSealed(initialRuntime)).toBe(true);

      const controller = new RunController(
        new FakeRunStore() as any,
        new FakeSessionManager() as any,
        new FakeAuditStore() as any,
        () => { throw new Error("not called"); },
        new InMemoryRoleBasedRunPersistence(),
      );

      const result = await controller.executeRoleBasedRun("ses_test", config, prepared);

      expect(instancesCreated).toBe(2);
      expect(adapter1Closed).toBe(true);
      expect(adapter2Initialized).toBe(true);
      expect(result.run.status).toBe("completed");
      expect(result.run.finalSummary).toBe("Instance 2 succeeded");

      // Assertions required by Section 4:
      // same participantId
      expect(initialRuntime.participantId).toBe(prepared.plans[0]!.participantId);
      // same roleId
      expect(initialRuntime.roleId).toBe("architect");
      // same adapterId
      expect(initialRuntime.adapterId).toBe("acp:claude");
      // same ParticipantConfig
      expect(prepared.plans[0]!.config).toEqual({ adapterType: "acp:claude" });
      // different adapter object allowed
      expect(initialRuntime.adapter).not.toBe(initialAdapter);
      expect((initialRuntime.adapter as TestMockAdapter).instanceNum).toBe(2);
    });
  });

  describe("Batch Atomic Preparation (prepareParticipants)", () => {
    it("successfully prepares all participants when preflight passes", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Batch prep test",
        policy: {
          roleSequence: ["architect", "implementer", "verifier"],
          loopMode: "once",
          terminalRoles: ["verifier"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "acp:antigravity" },
          verifier: { adapterType: "subprocess-jsonl", command: ["/bin/sh", "-c", "true"] },
        },
      };

      const prepared = prepareParticipants(config, registry, {
        locator: fakeLocator,
      });

      expect(prepared.plans).toHaveLength(3);
      expect(prepared.runtimes).toHaveLength(3);
      expect(prepared.records.participantIds).toHaveLength(3);

      expect(prepared.plans[0]?.roleId).toBe("architect");
      expect(prepared.plans[1]?.roleId).toBe("implementer");
      expect(prepared.plans[2]?.roleId).toBe("verifier");

      expect(prepared.runtimes[0]?.adapterId).toBe("acp:claude");
      expect(prepared.runtimes[1]?.adapterId).toBe("acp:antigravity");
      expect(prepared.runtimes[2]?.adapterId).toBe("subprocess-jsonl");

      for (const id of prepared.records.participantIds) {
        expect(prepared.records.participantsById[id]?.status).toBe("pending");
      }
    });

    it("batch preparation fails atomically if any participant fails preflight (zero adapters created)", () => {
      const registry = createStandardRegistry();
      const config: CollaborationConfig = {
        objective: "Atomic failure test",
        policy: {
          roleSequence: ["architect", "implementer"],
          loopMode: "once",
          terminalRoles: ["implementer"],
        },
        roles: {
          architect: { adapterType: "acp:claude" },
          implementer: { adapterType: "subprocess-jsonl", command: ["missing-cmd-xyz"] },
        },
      };

      let factoryCalls = 0;
      const countingFactory = (cfg: ParticipantConfig) => {
        factoryCalls++;
        return createParticipantAdapter(cfg);
      };

      expect(() =>
        prepareParticipants(config, registry, {
          locator: fakeLocator,
          factory: countingFactory,
        }),
      ).toThrow(ParticipantPreflightError);

      // Verify ZERO adapters were instantiated due to atomic preflight abort
      expect(factoryCalls).toBe(0);
    });
  });

  describe("Security & Default Locator", () => {
    it("defaultExecutableLocator resolves real system binaries without spawning", () => {
      const bunPath = defaultExecutableLocator("bun");
      expect(bunPath).toBeDefined();
      expect(typeof bunPath).toBe("string");

      const nonExistent = defaultExecutableLocator("absolutely_nonexistent_binary_xyz_123");
      expect(nonExistent).toBeUndefined();
    });

    it("preflight and factory do not accept token or credential parameters", () => {
      const suspiciousConfig: any = {
        adapterType: "acp:claude",
        apiKey: "sk-ant-test-token",
        token: "bearer_token_123",
      };

      const result = preflightParticipant(suspiciousConfig, fakeLocator);
      expect(result.ok).toBe(true);

      const adapter = createParticipantAdapter(suspiciousConfig);
      // Adapter options must not capture or leak token fields
      expect((adapter as any).options.apiKey).toBeUndefined();
      expect((adapter as any).options.token).toBeUndefined();
    });
  });
});
