import {
  type RoleId,
  type RoleDefinition,
  type ParticipantConfig,
  type ParticipantRecord,
  type RoleAssignment,
  type CollaborationConfig,
} from "./collaboration-domain";
import { assertValidCollaborationConfig } from "./collaboration-validation";
import { RoleRegistry } from "./role-registry";
import { generateParticipantId } from "./ids";
import { BridgeError } from "./errors";

/**
 * Pure, canonical plan for instantiating a participant for a role-based run.
 * Contains no process handles, sockets, or runtime state.
 */
export interface ParticipantAssignmentPlan {
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly role: Readonly<RoleDefinition>;
  /**
   * The explicit configured adapter identifier (e.g. "acp:claude", "acp:antigravity", "subprocess-jsonl").
   * Preserves exact provenance even if the underlying adapter class uses a generic id like "acp".
   */
  readonly adapterId: string;
  readonly config: ParticipantConfig;
  readonly sequenceIndex: number;
}

export interface CreateParticipantPlansOptions {
  readonly idFactory?: () => string;
}

export interface CreateInitialRecordsOptions {
  readonly clock?: () => string;
}

export interface InitialParticipantRecords {
  readonly participantIds: readonly string[];
  readonly participantsById: Readonly<Record<string, ParticipantRecord>>;
}

/**
 * Normalizes either dictionary form (`Partial<Record<RoleId, ParticipantConfig>>`)
 * or array form (`readonly RoleAssignment[]`) into a canonical readonly array of RoleAssignments.
 */
export function normalizeRoleAssignments(
  roles: Partial<Record<RoleId, ParticipantConfig>> | readonly RoleAssignment[],
): readonly RoleAssignment[] {
  if (Array.isArray(roles)) {
    const seen = new Set<string>();
    const normalized: RoleAssignment[] = [];
    for (const assignment of roles) {
      if (!assignment || typeof assignment !== "object") {
        throw new BridgeError(
          "invalid_role_assignment",
          "Role assignment must be an object",
          false,
        );
      }
      if (seen.has(assignment.roleId)) {
        throw new BridgeError(
          "duplicate_role_assignment",
          `Duplicate role assignment for role '${assignment.roleId}'`,
          false,
        );
      }
      seen.add(assignment.roleId);
      normalized.push(Object.freeze({
        roleId: assignment.roleId,
        participantConfig: Object.freeze({ ...assignment.participantConfig }),
      }));
    }
    return Object.freeze(normalized);
  }

  if (typeof roles === "object" && roles !== null) {
    const normalized: RoleAssignment[] = [];
    for (const [roleId, config] of Object.entries(roles)) {
      if (!config) continue;
      normalized.push(Object.freeze({
        roleId: roleId as RoleId,
        participantConfig: Object.freeze({ ...config }),
      }));
    }
    return Object.freeze(normalized);
  }

  throw new BridgeError(
    "invalid_role_assignment",
    "Roles configuration must be an object or array",
    false,
  );
}

/**
 * Generates canonical ParticipantAssignmentPlans for each scheduled role in policy.roleSequence.
 *
 * Invariants:
 * 1. Strictly ordered by config.policy.roleSequence, regardless of input dictionary key order.
 * 2. Validates aggregate configuration against the registry before creating plans.
 * 3. Preserves the configured adapter identifier (e.g. "acp:claude", "acp:antigravity") as plan.adapterId.
 * 4. Generates unique participant IDs (defaulting to prefix "part_").
 * 5. Pure domain logic: zero subprocesses, zero network I/O, zero external adapter instances.
 */
export function createParticipantAssignmentPlans(
  config: CollaborationConfig,
  registry: RoleRegistry,
  options?: CreateParticipantPlansOptions,
): readonly ParticipantAssignmentPlan[] {
  // Validate complete configuration against registered roles
  assertValidCollaborationConfig(config, registry.list());

  const assignments = normalizeRoleAssignments(config.roles);
  const assignmentMap = new Map<RoleId, ParticipantConfig>();
  for (const assignment of assignments) {
    assignmentMap.set(assignment.roleId, assignment.participantConfig);
  }

  const idFactory = options?.idFactory ?? generateParticipantId;
  const plans: ParticipantAssignmentPlan[] = [];
  const assignedParticipantIds = new Set<string>();

  for (let index = 0; index < config.policy.roleSequence.length; index++) {
    const roleId = config.policy.roleSequence[index]!;
    const role = registry.require(roleId);
    const participantConfig = assignmentMap.get(roleId);

    if (!participantConfig) {
      throw new BridgeError(
        "missing_role_assignment",
        `Missing participant configuration for scheduled role '${roleId}'`,
        false,
      );
    }

    const participantId = idFactory();
    if (assignedParticipantIds.has(participantId)) {
      throw new BridgeError(
        "duplicate_participant_id",
        `Generated duplicate participant ID '${participantId}'`,
        false,
      );
    }
    assignedParticipantIds.add(participantId);

    plans.push(Object.freeze({
      participantId,
      roleId,
      role,
      adapterId: participantConfig.adapterType,
      config: participantConfig,
      sequenceIndex: index,
    }));
  }

  return Object.freeze(plans);
}

/**
 * Creates serializable initial ParticipantRecords from canonical assignment plans.
 *
 * Invariants:
 * 1. Starts with status "pending".
 * 2. turnsExecuted = 0, consecutiveFailures = 0.
 * 3. Contains strictly serializable state (no process handles, closures, or sockets).
 * 4. adapterId matches the configured adapterType from the plan.
 */
export function createInitialParticipantRecords(
  plans: readonly ParticipantAssignmentPlan[],
  options?: CreateInitialRecordsOptions,
): InitialParticipantRecords {
  const clock = options?.clock ?? (() => new Date().toISOString());
  const now = clock();

  const participantIds: string[] = [];
  const participantsById: Record<string, ParticipantRecord> = {};

  for (const plan of plans) {
    participantIds.push(plan.participantId);
    participantsById[plan.participantId] = Object.freeze({
      id: plan.participantId,
      roleId: plan.roleId,
      adapterId: plan.adapterId,
      status: "pending",
      turnsExecuted: 0,
      consecutiveFailures: 0,
      createdAt: now,
    });
  }

  return Object.freeze({
    participantIds: Object.freeze(participantIds),
    participantsById: Object.freeze(participantsById),
  });
}
