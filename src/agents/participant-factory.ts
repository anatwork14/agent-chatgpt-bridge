import { existsSync } from "node:fs";
import { resolve, join, delimiter } from "node:path";
import { type ExternalAgentAdapter } from "../core/domain";
import {
  type RoleId,
  type ParticipantConfig,
  type CollaborationConfig,
} from "../core/collaboration-domain";
import {
  type ParticipantAssignmentPlan,
  type InitialParticipantRecords,
  createParticipantAssignmentPlans,
  createInitialParticipantRecords,
  type CreateParticipantPlansOptions,
  type CreateInitialRecordsOptions,
} from "../core/participant-assignment";
import { type RoleRegistry } from "../core/role-registry";
import { BridgeError } from "../core/errors";
import {
  ACP_AGENT_PROFILES,
  resolveAcpProfile,
  customAcpProfile,
} from "./acp/profiles";
import { AcpAgentAdapter } from "./acp/adapter";
import type { AcpPermissionMode } from "./acp/types";
import { SubprocessJsonlAdapter } from "./subprocess-jsonl";

/**
 * Pluggable executable locator for preflight checks.
 * Returns the resolved executable path if it exists, or undefined if not found.
 * Must NOT spawn child processes or perform network requests.
 */
export type ExecutableLocator = (command: string, cwd?: string) => string | undefined;

export interface ParticipantPreflightIssue {
  readonly code: string;
  readonly message: string;
}

export interface ParticipantPreflightResult {
  readonly ok: boolean;
  readonly issues: readonly ParticipantPreflightIssue[];
  readonly resolvedExecutable?: string;
  readonly command: readonly string[];
}

export class ParticipantPreflightError extends BridgeError {
  constructor(
    public readonly issues: readonly ParticipantPreflightIssue[],
    public readonly participantId?: string,
    public readonly roleId?: string,
  ) {
    const detail = issues.map(i => `[${i.code}] ${i.message}`).join("; ");
    super("participant_preflight_failed", `Participant preflight failed: ${detail}`, false);
    this.name = "ParticipantPreflightError";
  }
}

import type {
  ParticipantRuntime,
  PreparedRoleParticipants,
} from "../core/collaboration-runtime";

export type { ParticipantRuntime, PreparedRoleParticipants };
export type PreparedParticipants = PreparedRoleParticipants;

export type ParticipantAdapterFactory = (config: ParticipantConfig) => ExternalAgentAdapter;

export interface PrepareParticipantsOptions
  extends CreateParticipantPlansOptions,
    CreateInitialRecordsOptions {
  readonly locator?: ExecutableLocator;
  readonly factory?: ParticipantAdapterFactory;
}

/**
 * Default non-spawning executable locator.
 * Resolves relative/absolute file paths against cwd, or checks PATH via Bun.which / filesystem.
 */
export function defaultExecutableLocator(command: string, cwd?: string): string | undefined {
  if (!command || !command.trim()) return undefined;
  const trimmed = command.trim();

  // If the command contains path separators, check the explicit filesystem location
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    const resolved = resolve(cwd ?? process.cwd(), trimmed);
    return existsSync(resolved) ? resolved : undefined;
  }

  // Under Bun, Bun.which searches PATH directly without spawning child processes
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which(trimmed);
    if (found) return found;
  }

  // Fallback: manual PATH search without child processes
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = join(part.trim().replace(/^"(.*)"$/, "$1"), trimmed);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

const VALID_PERMISSION_MODES = new Set<string>(["deny", "allow_readonly", "delegate"]);

/**
 * Pure non-spawning preflight validation for a participant's configuration.
 *
 * Guarantees:
 * 1. Zero child process spawns, zero network calls, zero authentication handshakes.
 * 2. Does not inspect credentials or environment secrets.
 * 3. Enforces profile validity and rejects ambiguous command overrides.
 * 4. Fails closed on unresolvable binaries or unsupported adapters.
 */
export function preflightParticipant(
  config: ParticipantConfig,
  locator: ExecutableLocator = defaultExecutableLocator,
): ParticipantPreflightResult {
  const issues: ParticipantPreflightIssue[] = [];

  if (!config || typeof config !== "object") {
    return {
      ok: false,
      issues: [{ code: "invalid_participant_config", message: "Participant config must be an object" }],
      command: [],
    };
  }

  const adapterType = config.adapterType;
  if (typeof adapterType !== "string" || !adapterType.trim()) {
    return {
      ok: false,
      issues: [{ code: "missing_adapter_type", message: "adapterType is required" }],
      command: [],
    };
  }

  // Case 1: Built-in ACP Profile ("acp:<profile>")
  if (adapterType.startsWith("acp:")) {
    const profileId = adapterType.slice(4).trim();
    const profile = ACP_AGENT_PROFILES[profileId as keyof typeof ACP_AGENT_PROFILES];

    if (!profile) {
      return {
        ok: false,
        issues: [{
          code: "unknown_acp_profile",
          message: `Unknown ACP agent profile '${profileId}'. Known profiles: ${Object.keys(ACP_AGENT_PROFILES).join(", ")}`,
        }],
        command: [],
      };
    }

    if (config.command && config.command.length > 0) {
      issues.push({
        code: "ambiguous_acp_command_override",
        message: `Custom command must not be provided with built-in ACP profile '${profileId}'. Use 'acp' adapterType for custom commands.`,
      });
    }

    if (config.config?.permissionMode !== undefined) {
      if (!VALID_PERMISSION_MODES.has(config.config.permissionMode)) {
        issues.push({
          code: "invalid_permission_mode",
          message: `Invalid permissionMode '${config.config.permissionMode}'. Valid modes: deny, allow_readonly, delegate`,
        });
      }
    }

    const command = profile.command;
    const binary = command[0]!;
    const resolvedExecutable = locator(binary, config.cwd);
    if (!resolvedExecutable) {
      issues.push({
        code: "executable_not_found",
        message: `Executable '${binary}' for ACP profile '${profileId}' was not found`,
      });
    }

    return {
      ok: issues.length === 0,
      issues: Object.freeze(issues),
      resolvedExecutable,
      command: Object.freeze([...command]),
    };
  }

  // Case 2: Custom ACP ("acp")
  if (adapterType === "acp") {
    if (config.command && config.command.length > 0) {
      if (config.config?.permissionMode !== undefined) {
        if (!VALID_PERMISSION_MODES.has(config.config.permissionMode)) {
          issues.push({
            code: "invalid_permission_mode",
            message: `Invalid permissionMode '${config.config.permissionMode}'. Valid modes: deny, allow_readonly, delegate`,
          });
        }
      }

      const binary = config.command[0]!;
      const resolvedExecutable = locator(binary, config.cwd);
      if (!resolvedExecutable) {
        issues.push({
          code: "executable_not_found",
          message: `Executable '${binary}' for custom ACP adapter was not found`,
        });
      }

      return {
        ok: issues.length === 0,
        issues: Object.freeze(issues),
        resolvedExecutable,
        command: Object.freeze([...config.command]),
      };
    }

    if (config.config?.profile) {
      const profile = ACP_AGENT_PROFILES[config.config.profile as keyof typeof ACP_AGENT_PROFILES];
      if (!profile) {
        issues.push({
          code: "unknown_acp_profile",
          message: `Unknown ACP agent profile '${config.config.profile}' specified in config`,
        });
        return {
          ok: false,
          issues: Object.freeze(issues),
          command: [],
        };
      }

      const binary = profile.command[0]!;
      const resolvedExecutable = locator(binary, config.cwd);
      if (!resolvedExecutable) {
        issues.push({
          code: "executable_not_found",
          message: `Executable '${binary}' for ACP profile '${config.config.profile}' was not found`,
        });
      }

      return {
        ok: issues.length === 0,
        issues: Object.freeze(issues),
        resolvedExecutable,
        command: Object.freeze([...profile.command]),
      };
    }

    return {
      ok: false,
      issues: [{
        code: "missing_acp_command",
        message: "Adapter 'acp' requires a non-empty command array or a valid profile in config",
      }],
      command: [],
    };
  }

  // Case 3: Subprocess JSONL ("subprocess-jsonl")
  if (adapterType === "subprocess-jsonl") {
    if (!config.command || config.command.length === 0) {
      return {
        ok: false,
        issues: [{
          code: "missing_subprocess_command",
          message: "Adapter 'subprocess-jsonl' requires a non-empty command array",
        }],
        command: [],
      };
    }

    if (config.config?.permissionMode !== undefined) {
      issues.push({
        code: "unsupported_config_field",
        message: "'permissionMode' is not supported for adapter 'subprocess-jsonl' (ACP only)",
      });
    }

    const binary = config.command[0]!;
    const resolvedExecutable = locator(binary, config.cwd);
    if (!resolvedExecutable) {
      issues.push({
        code: "executable_not_found",
        message: `Executable '${binary}' for subprocess-jsonl adapter was not found`,
      });
    }

    return {
      ok: issues.length === 0,
      issues: Object.freeze(issues),
      resolvedExecutable,
      command: Object.freeze([...config.command]),
    };
  }

  // Case 4: Unsupported adapter type
  return {
    ok: false,
    issues: [{
      code: "unsupported_adapter_type",
      message: `Unsupported adapter type '${adapterType}'`,
    }],
    command: Object.freeze(config.command ? [...config.command] : []),
  };
}

/**
 * Instantiates an ExternalAgentAdapter from a ParticipantConfig.
 *
 * Invariants:
 * 1. Pure construction: DOES NOT spawn any child processes or connect to external runtimes.
 * 2. Preserves permissionMode strictly into ACP adapter options.
 * 3. Fails closed for unsupported adapter types.
 */
export function createParticipantAdapter(config: ParticipantConfig): ExternalAgentAdapter {
  const adapterType = config.adapterType;

  if (adapterType.startsWith("acp:")) {
    const profileId = adapterType.slice(4).trim();
    const permissionMode = config.config?.permissionMode as AcpPermissionMode | undefined;
    const profile = resolveAcpProfile(profileId, undefined, {
      cwd: config.cwd,
      permissionMode,
    });
    return new AcpAgentAdapter(profile, {
      cwd: config.cwd,
      permissionMode,
    });
  }

  if (adapterType === "acp") {
    const permissionMode = config.config?.permissionMode as AcpPermissionMode | undefined;
    if (config.command && config.command.length > 0) {
      const profile = customAcpProfile(config.command, {
        cwd: config.cwd,
        permissionMode,
      });
      return new AcpAgentAdapter(profile, {
        cwd: config.cwd,
        permissionMode,
      });
    }
    if (config.config?.profile) {
      const profile = resolveAcpProfile(config.config.profile, undefined, {
        cwd: config.cwd,
        permissionMode,
      });
      return new AcpAgentAdapter(profile, {
        cwd: config.cwd,
        permissionMode,
      });
    }
    throw new BridgeError(
      "agent_protocol_invalid",
      "Adapter 'acp' requires a non-empty command array or a valid profile",
      false,
    );
  }

  if (adapterType === "subprocess-jsonl") {
    if (!config.command || config.command.length === 0) {
      throw new BridgeError(
        "agent_protocol_invalid",
        "Adapter 'subprocess-jsonl' requires a non-empty command array",
        false,
      );
    }
    return new SubprocessJsonlAdapter(config.command, {
      cwd: config.cwd,
    });
  }

  throw new BridgeError(
    "participant_adapter_unsupported",
    `Unsupported adapter type '${adapterType}'`,
    false,
  );
}

/**
 * Binds a canonical participant assignment plan to an instantiated adapter runtime.
 * Preserves the configured adapterId (e.g. "acp:claude") even if the adapter class reports "acp".
 */
export function bindParticipant(
  plan: ParticipantAssignmentPlan,
  factory: ParticipantAdapterFactory = createParticipantAdapter,
): ParticipantRuntime {
  const adapter = factory(plan.config);
  return Object.freeze({
    participantId: plan.participantId,
    roleId: plan.roleId,
    adapterId: plan.adapterId,
    adapter,
    recreateAdapter: () => factory(plan.config),
  });
}

/**
 * High-level atomic preparation for collaboration participants.
 *
 * Sequence:
 * 1. Generates canonical assignment plans from config and registry.
 * 2. Preflights ALL participants using non-spawning locator.
 * 3. If ANY participant fails preflight, aborts atomically with ParticipantPreflightError (0 adapters created).
 * 4. Binds valid participants into ParticipantRuntime memory objects.
 * 5. Generates serializable initial ParticipantRecords.
 */
export function prepareParticipants(
  config: CollaborationConfig,
  registry: RoleRegistry,
  options?: PrepareParticipantsOptions,
): PreparedParticipants {
  const plans = createParticipantAssignmentPlans(config, registry, options);
  const locator = options?.locator ?? defaultExecutableLocator;

  const preflightIssues: { plan: ParticipantAssignmentPlan; issue: ParticipantPreflightIssue }[] = [];
  for (const plan of plans) {
    const result = preflightParticipant(plan.config, locator);
    if (!result.ok) {
      for (const issue of result.issues) {
        preflightIssues.push({ plan, issue });
      }
    }
  }

  if (preflightIssues.length > 0) {
    const issues = preflightIssues.map(p => p.issue);
    const firstPlan = preflightIssues[0]!.plan;
    throw new ParticipantPreflightError(issues, firstPlan.participantId, firstPlan.roleId);
  }

  const factory = options?.factory ?? createParticipantAdapter;
  const runtimes = plans.map(plan => bindParticipant(plan, factory));
  const records = createInitialParticipantRecords(plans, options);

  return Object.freeze({
    plans,
    runtimes: Object.freeze(runtimes),
    records,
  });
}
