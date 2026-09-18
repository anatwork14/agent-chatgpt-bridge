import {
  BUILTIN_ROLE_IDS,
  P4_LIMITS,
  P4_DEFAULT_BUDGET,
  type BuiltinRoleId,
  type RoleId,
  type RoleDefinition,
  type RoleBasedRunBudget,
  type RunPolicy,
  type ParticipantConfig,
  type RoleAssignment,
  type CollaborationConfig,
} from "./collaboration-domain";
import { BridgeError } from "./errors";

/**
 * Bounded deterministic role identifier format:
 * - 1 to 64 characters
 * - Starts with a lowercase ASCII letter [a-z]
 * - Contains only lowercase ASCII letters, numbers, underscores, or hyphens [a-z0-9_-]
 */
export const ROLE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CollaborationValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class CollaborationValidationError extends BridgeError {
  constructor(public readonly issues: readonly CollaborationValidationIssue[]) {
    const detail = issues.map(i => `${i.path}: [${i.code}] ${i.message}`).join("; ");
    super("invalid_collaboration_config", `Collaboration validation failed: ${detail}`, false);
    this.name = "CollaborationValidationError";
  }
}

/**
 * Pure check whether a candidate string is a valid RoleId.
 */
export function isValidRoleId(candidate: unknown): candidate is RoleId {
  return typeof candidate === "string" && ROLE_ID_REGEX.test(candidate);
}

/**
 * Validates a single RoleDefinition object.
 */
export function validateRoleDefinition(
  role: unknown,
  path = "role",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  if (typeof role !== "object" || role === null) {
    return [
      {
        code: "invalid_role_definition",
        path,
        message: "Role definition must be a non-null object",
      },
    ];
  }

  const r = role as Partial<RoleDefinition>;

  if (!isValidRoleId(r.id)) {
    issues.push({
      code: "invalid_role_id",
      path: `${path}.id`,
      message:
        "Role id must match /^[a-z][a-z0-9_-]{0,63}$/ (1-64 lowercase chars, starting with [a-z])",
    });
  }

  if (typeof r.name !== "string" || r.name.trim().length === 0) {
    issues.push({
      code: "invalid_role_name",
      path: `${path}.name`,
      message: "Role name must be a non-empty string",
    });
  }

  if (typeof r.description !== "string" || r.description.trim().length === 0) {
    issues.push({
      code: "invalid_role_description",
      path: `${path}.description`,
      message: "Role description must be a non-empty string",
    });
  }

  if (typeof r.systemInstructions !== "string" || r.systemInstructions.trim().length === 0) {
    issues.push({
      code: "invalid_role_system_instructions",
      path: `${path}.systemInstructions`,
      message: "Role systemInstructions must be a non-empty string",
    });
  }

  if (r.expectedInputSummary !== undefined && typeof r.expectedInputSummary !== "string") {
    issues.push({
      code: "invalid_role_expected_input",
      path: `${path}.expectedInputSummary`,
      message: "Role expectedInputSummary must be a string if provided",
    });
  }

  if (r.outputContract !== undefined) {
    if (
      typeof r.outputContract !== "object" ||
      r.outputContract === null ||
      (r.outputContract.type !== "text" && r.outputContract.type !== "json_schema")
    ) {
      issues.push({
        code: "invalid_output_contract",
        path: `${path}.outputContract`,
        message: "outputContract must be an object with type 'text' or 'json_schema'",
      });
    }
  }

  return issues;
}

/**
 * Validates an array or record of RoleDefinitions, ensuring uniqueness of role IDs.
 */
export function validateRoleDefinitions(
  roles: unknown,
  path = "roles",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  let roleList: RoleDefinition[];
  if (Array.isArray(roles)) {
    roleList = roles as RoleDefinition[];
  } else if (typeof roles === "object" && roles !== null) {
    roleList = Object.values(roles) as RoleDefinition[];
  } else {
    return [
      {
        code: "invalid_role_definitions",
        path,
        message: "Roles must be an array or map of role definitions",
      },
    ];
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < roleList.length; i++) {
    const r = roleList[i];
    const rolePath = Array.isArray(roles) ? `${path}[${i}]` : `${path}.${(r as any)?.id ?? i}`;
    const itemIssues = validateRoleDefinition(r, rolePath);
    issues.push(...itemIssues);

    if (r && typeof r.id === "string") {
      if (seenIds.has(r.id)) {
        issues.push({
          code: "duplicate_role",
          path: `${rolePath}.id`,
          message: `Duplicate role id: '${r.id}'`,
        });
      } else {
        seenIds.add(r.id);
      }
    }
  }

  return issues;
}

/**
 * Validates a RoleBasedRunBudget against positive integer and hard safety limits.
 */
export function validateRunBudget(
  budget: unknown,
  path = "budget",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  if (typeof budget !== "object" || budget === null) {
    return [
      {
        code: "invalid_budget",
        path,
        message: "Budget must be a non-null object",
      },
    ];
  }

  const b = budget as Partial<RoleBasedRunBudget>;

  // maxTurns
  if (
    typeof b.maxTurns !== "number" ||
    !Number.isInteger(b.maxTurns) ||
    b.maxTurns <= 0
  ) {
    issues.push({
      code: "invalid_budget",
      path: `${path}.maxTurns`,
      message: "maxTurns must be a positive integer",
    });
  } else if (b.maxTurns > P4_LIMITS.maxTurns) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxTurns`,
      message: `maxTurns (${b.maxTurns}) exceeds hard limit (${P4_LIMITS.maxTurns})`,
    });
  }

  // maxParticipants
  if (
    typeof b.maxParticipants !== "number" ||
    !Number.isInteger(b.maxParticipants) ||
    b.maxParticipants <= 0
  ) {
    issues.push({
      code: "invalid_budget",
      path: `${path}.maxParticipants`,
      message: "maxParticipants must be a positive integer",
    });
  } else if (b.maxParticipants > P4_LIMITS.maxParticipants) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxParticipants`,
      message: `maxParticipants (${b.maxParticipants}) exceeds hard limit (${P4_LIMITS.maxParticipants})`,
    });
  }

  // maxParallelTurns: MUST be 1 in P4
  if (b.maxParallelTurns !== 1) {
    issues.push({
      code: "invalid_parallelism",
      path: `${path}.maxParallelTurns`,
      message: `maxParallelTurns must be 1 in P4 (received: ${String(b.maxParallelTurns)}). Parallel DAG execution is reserved for P5.`,
    });
  }

  // maxRetriesPerParticipant
  if (
    typeof b.maxRetriesPerParticipant !== "number" ||
    !Number.isInteger(b.maxRetriesPerParticipant) ||
    b.maxRetriesPerParticipant < 0
  ) {
    issues.push({
      code: "invalid_budget",
      path: `${path}.maxRetriesPerParticipant`,
      message: "maxRetriesPerParticipant must be a non-negative integer (>= 0)",
    });
  } else if (b.maxRetriesPerParticipant > P4_LIMITS.maxRetriesPerParticipant) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxRetriesPerParticipant`,
      message: `maxRetriesPerParticipant (${b.maxRetriesPerParticipant}) exceeds hard limit (${P4_LIMITS.maxRetriesPerParticipant})`,
    });
  }

  // maxWallClockMs
  if (
    typeof b.maxWallClockMs !== "number" ||
    !Number.isFinite(b.maxWallClockMs) ||
    b.maxWallClockMs <= 0
  ) {
    issues.push({
      code: "invalid_budget",
      path: `${path}.maxWallClockMs`,
      message: "maxWallClockMs must be a positive finite number",
    });
  } else if (b.maxWallClockMs > P4_LIMITS.maxWallClockMs) {
    issues.push({
      code: "budget_limit_exceeded",
      path: `${path}.maxWallClockMs`,
      message: `maxWallClockMs (${b.maxWallClockMs}) exceeds hard limit (${P4_LIMITS.maxWallClockMs} ms)`,
    });
  }

  // tokenBudget (optional)
  if (b.tokenBudget !== undefined) {
    if (typeof b.tokenBudget !== "object" || b.tokenBudget === null) {
      issues.push({
        code: "invalid_budget",
        path: `${path}.tokenBudget`,
        message: "tokenBudget must be an object if provided",
      });
    } else {
      const tb = b.tokenBudget;
      if (tb.maxInputTokens !== undefined && (!Number.isFinite(tb.maxInputTokens) || tb.maxInputTokens <= 0)) {
        issues.push({ code: "invalid_budget", path: `${path}.tokenBudget.maxInputTokens`, message: "maxInputTokens must be a positive number" });
      }
      if (tb.maxOutputTokens !== undefined && (!Number.isFinite(tb.maxOutputTokens) || tb.maxOutputTokens <= 0)) {
        issues.push({ code: "invalid_budget", path: `${path}.tokenBudget.maxOutputTokens`, message: "maxOutputTokens must be a positive number" });
      }
      if (tb.maxTotalTokens !== undefined && (!Number.isFinite(tb.maxTotalTokens) || tb.maxTotalTokens <= 0)) {
        issues.push({ code: "invalid_budget", path: `${path}.tokenBudget.maxTotalTokens`, message: "maxTotalTokens must be a positive number" });
      }
    }
  }

  return issues;
}

/**
 * Validates a RunPolicy:
 * - non-empty roleSequence
 * - loopMode is 'once' | 'repeat_until_done'
 * - terminalRoles non-empty
 * - terminalRoles must exist in knownRoleIds (if supplied) and must appear in roleSequence
 */
export function validateRunPolicy(
  policy: unknown,
  knownRoleIds?: ReadonlySet<string>,
  path = "policy",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  if (typeof policy !== "object" || policy === null) {
    return [
      {
        code: "invalid_policy",
        path,
        message: "Run policy must be a non-null object",
      },
    ];
  }

  const p = policy as Partial<RunPolicy>;

  // roleSequence
  if (!Array.isArray(p.roleSequence) || p.roleSequence.length === 0) {
    issues.push({
      code: "empty_role_sequence",
      path: `${path}.roleSequence`,
      message: "roleSequence must be a non-empty array of role IDs",
    });
  } else {
    for (let i = 0; i < p.roleSequence.length; i++) {
      const roleId = p.roleSequence[i];
      if (!isValidRoleId(roleId)) {
        issues.push({
          code: "invalid_role_id",
          path: `${path}.roleSequence[${i}]`,
          message: `Invalid role id '${String(roleId)}'`,
        });
      } else if (knownRoleIds && !knownRoleIds.has(roleId)) {
        issues.push({
          code: "unknown_role",
          path: `${path}.roleSequence[${i}]`,
          message: `Scheduled role '${roleId}' is not registered`,
        });
      }
    }
  }

  // loopMode
  if (p.loopMode !== "once" && p.loopMode !== "repeat_until_done") {
    issues.push({
      code: "invalid_loop_mode",
      path: `${path}.loopMode`,
      message: "loopMode must be 'once' or 'repeat_until_done'",
    });
  }

  // terminalRoles
  if (!Array.isArray(p.terminalRoles) || p.terminalRoles.length === 0) {
    issues.push({
      code: "missing_terminal_role",
      path: `${path}.terminalRoles`,
      message: "terminalRoles must contain at least one designated terminal role",
    });
  } else {
    const scheduledSet = new Set(Array.isArray(p.roleSequence) ? p.roleSequence : []);

    for (let i = 0; i < p.terminalRoles.length; i++) {
      const termRole = p.terminalRoles[i];
      if (!isValidRoleId(termRole)) {
        issues.push({
          code: "invalid_role_id",
          path: `${path}.terminalRoles[${i}]`,
          message: `Invalid terminal role id '${String(termRole)}'`,
        });
      } else {
        if (knownRoleIds && !knownRoleIds.has(termRole)) {
          issues.push({
            code: "unknown_role",
            path: `${path}.terminalRoles[${i}]`,
            message: `Terminal role '${termRole}' is not registered`,
          });
        }
        if (!scheduledSet.has(termRole)) {
          issues.push({
            code: "terminal_role_not_scheduled",
            path: `${path}.terminalRoles[${i}]`,
            message: `Terminal role '${termRole}' does not appear in policy.roleSequence`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Validates a single ParticipantConfig.
 * Pure validation does NOT probe the filesystem or execute processes.
 */
export function validateParticipantConfig(
  config: unknown,
  path = "participantConfig",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  if (typeof config !== "object" || config === null) {
    return [
      {
        code: "invalid_participant_config",
        path,
        message: "Participant config must be a non-null object",
      },
    ];
  }

  const c = config as Partial<ParticipantConfig>;

  if (typeof c.adapterType !== "string" || c.adapterType.trim().length === 0) {
    issues.push({
      code: "invalid_adapter_type",
      path: `${path}.adapterType`,
      message: "adapterType must be a non-empty string",
    });
  }

  if (c.command !== undefined) {
    if (!Array.isArray(c.command) || c.command.length === 0 || !c.command.every(arg => typeof arg === "string")) {
      issues.push({
        code: "invalid_participant_config",
        path: `${path}.command`,
        message: "command must be a non-empty array of strings if provided",
      });
    }
  }

  if (c.config !== undefined && (typeof c.config !== "object" || c.config === null)) {
    issues.push({
      code: "invalid_participant_config",
      path: `${path}.config`,
      message: "config must be an object if provided",
    });
  }

  if (c.cwd !== undefined && (typeof c.cwd !== "string" || c.cwd.trim().length === 0)) {
    issues.push({
      code: "invalid_participant_config",
      path: `${path}.cwd`,
      message: "cwd must be a non-empty string if provided",
    });
  }

  return issues;
}

/**
 * Validates role assignments (Record<RoleId, ParticipantConfig> or RoleAssignment[]).
 * Enforces one assignment per scheduled role and checks for unknown role assignments.
 */
export function validateRoleAssignments(
  assignments: unknown,
  knownRoleIds?: ReadonlySet<string>,
  scheduledRoles?: ReadonlySet<string>,
  path = "roles",
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  const normalized: Array<{ roleId: RoleId; config: ParticipantConfig; subpath: string }> = [];

  if (Array.isArray(assignments)) {
    for (let i = 0; i < assignments.length; i++) {
      const item = assignments[i];
      const itemPath = `${path}[${i}]`;
      if (typeof item !== "object" || item === null) {
        issues.push({
          code: "invalid_role_assignment",
          path: itemPath,
          message: "Role assignment must be an object with roleId and participantConfig",
        });
        continue;
      }
      normalized.push({
        roleId: (item as RoleAssignment).roleId,
        config: (item as RoleAssignment).participantConfig,
        subpath: itemPath,
      });
    }
  } else if (typeof assignments === "object" && assignments !== null) {
    for (const [roleId, config] of Object.entries(assignments)) {
      normalized.push({
        roleId: roleId as RoleId,
        config: config as ParticipantConfig,
        subpath: `${path}.${roleId}`,
      });
    }
  } else {
    return [
      {
        code: "invalid_role_assignments",
        path,
        message: "Assignments must be a map or array of role assignments",
      },
    ];
  }

  const assignedRoleIds = new Set<string>();

  for (const item of normalized) {
    if (!isValidRoleId(item.roleId)) {
      issues.push({
        code: "invalid_role_id",
        path: `${item.subpath}.roleId`,
        message: `Invalid role id '${String(item.roleId)}'`,
      });
    } else {
      if (assignedRoleIds.has(item.roleId)) {
        issues.push({
          code: "duplicate_role_assignment",
          path: item.subpath,
          message: `Duplicate assignment for role '${item.roleId}'`,
        });
      } else {
        assignedRoleIds.add(item.roleId);
      }

      if (knownRoleIds && !knownRoleIds.has(item.roleId)) {
        issues.push({
          code: "unknown_assignment_role",
          path: item.subpath,
          message: `Assignment references unregistered role '${item.roleId}'`,
        });
      }
    }

    const configIssues = validateParticipantConfig(item.config, `${item.subpath}.config`);
    issues.push(...configIssues);
  }

  // Cross-check against scheduled roles: every scheduled role MUST have an assignment
  if (scheduledRoles) {
    for (const scheduled of scheduledRoles) {
      if (!assignedRoleIds.has(scheduled)) {
        issues.push({
          code: "missing_assignment",
          path,
          message: `Scheduled role '${scheduled}' has no participant assignment`,
        });
      }
    }
  }

  return issues;
}

/**
 * Pure aggregate validator for a CollaborationConfig.
 * Verifies all cross-field invariants without any I/O, subprocess, or network calls.
 */
export function validateCollaborationConfig(
  config: unknown,
  knownRolesInput?: readonly RoleDefinition[] | ReadonlySet<string>,
): CollaborationValidationIssue[] {
  const issues: CollaborationValidationIssue[] = [];

  if (typeof config !== "object" || config === null) {
    return [
      {
        code: "invalid_collaboration_config",
        path: "config",
        message: "Collaboration configuration must be a non-null object",
      },
    ];
  }

  const c = config as Partial<CollaborationConfig>;

  // Objective validation
  if (typeof c.objective !== "string" || c.objective.trim().length === 0) {
    issues.push({
      code: "invalid_objective",
      path: "config.objective",
      message: "objective must be a non-empty string",
    });
  }

  // Determine known role IDs set
  let knownRoleIds: Set<string>;
  if (knownRolesInput) {
    if (knownRolesInput instanceof Set) {
      knownRoleIds = new Set<string>(knownRolesInput);
    } else if (Array.isArray(knownRolesInput)) {
      knownRoleIds = new Set<string>((knownRolesInput as readonly RoleDefinition[]).map(r => r.id));
    } else {
      knownRoleIds = new Set<string>(knownRolesInput as Iterable<string>);
    }
  } else {
    // Default to built-in roles if no custom definitions are passed
    knownRoleIds = new Set<string>(BUILTIN_ROLE_IDS);
  }

  // Policy validation
  const policyIssues = validateRunPolicy(c.policy, knownRoleIds, "config.policy");
  issues.push(...policyIssues);

  // Extract scheduled roles set
  const scheduledRoles = new Set<string>(
    c.policy && Array.isArray(c.policy.roleSequence) ? c.policy.roleSequence : [],
  );

  // Roles assignment validation
  const assignmentIssues = validateRoleAssignments(
    c.roles,
    knownRoleIds,
    scheduledRoles,
    "config.roles",
  );
  issues.push(...assignmentIssues);

  // Budget validation: merge user budget with defaults
  const effectiveBudget: RoleBasedRunBudget = {
    ...P4_DEFAULT_BUDGET,
    ...(c.budget ?? {}),
  };
  const budgetIssues = validateRunBudget(effectiveBudget, "config.budget");
  issues.push(...budgetIssues);

  // Participant count check against budget.maxParticipants
  let participantCount = 0;
  if (Array.isArray(c.roles)) {
    participantCount = c.roles.length;
  } else if (typeof c.roles === "object" && c.roles !== null) {
    participantCount = Object.keys(c.roles).length;
  }

  if (
    typeof effectiveBudget.maxParticipants === "number" &&
    participantCount > effectiveBudget.maxParticipants
  ) {
    issues.push({
      code: "participant_count_over_budget",
      path: "config.roles",
      message: `Configured participant count (${participantCount}) exceeds budget.maxParticipants (${effectiveBudget.maxParticipants})`,
    });
  }

  return issues;
}

/**
 * Asserts that a CollaborationConfig satisfies all P4 invariants,
 * throwing a structured CollaborationValidationError if any issue is detected.
 */
export function assertValidCollaborationConfig(
  config: unknown,
  knownRolesInput?: readonly RoleDefinition[] | ReadonlySet<string>,
): asserts config is CollaborationConfig {
  const issues = validateCollaborationConfig(config, knownRolesInput);
  if (issues.length > 0) {
    throw new CollaborationValidationError(issues);
  }
}
