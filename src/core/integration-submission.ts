import { ACP_AGENT_PROFILES } from "../agents/acp/profiles";
import {
  prepareParticipants,
  type PrepareParticipantsOptions,
  type PreparedParticipants,
} from "../agents/participant-factory";
import {
  BUILTIN_ROLE_IDS,
  type CollaborationConfig,
  type RoleAssignment,
  type RoleId,
} from "./collaboration-domain";
import {
  P5_LIMITS,
  type CollaborationDagBudget,
  type CollaborationDagDefinition,
  type CollaborationDagFailurePolicy,
} from "./collaboration-dag";
import { isValidCollaborationDagNodeId } from "./collaboration-dag-validation";
import { BridgeError } from "./errors";
import type { RunController } from "./run-controller";
import { createBuiltinRoleRegistry, type RoleRegistry } from "./role-registry";
import {
  createBridgeIntegrationDagRunProjection,
  normalizeBridgeIntegrationCorrelation,
  type BridgeIntegrationCorrelation,
  type BridgeIntegrationDagRunProjection,
} from "./integration-contract";

export const BRIDGE_INTEGRATION_SUBMISSION_SCHEMA_VERSION = 1 as const;
export const BRIDGE_INTEGRATION_OBJECTIVE_MAX_CHARS = 64_000;

export type BridgeIntegrationPermissionMode = "deny" | "allow_readonly";

export interface BridgeIntegrationParticipantSubmission {
  readonly roleId: RoleId;
  readonly adapterType: string;
  readonly permissionMode: BridgeIntegrationPermissionMode;
}

export interface BridgeIntegrationDagNodeSubmission {
  readonly id: string;
  readonly roleId: RoleId;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly terminal?: boolean;
  readonly retryLimit?: number;
  readonly timeoutMs?: number;
}

export interface BridgeIntegrationDagSubmission {
  readonly schemaVersion: typeof BRIDGE_INTEGRATION_SUBMISSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly objective: string;
  readonly participants: readonly BridgeIntegrationParticipantSubmission[];
  readonly graph: {
    readonly version: 1;
    readonly nodes: readonly BridgeIntegrationDagNodeSubmission[];
  };
  readonly budget?: Partial<CollaborationDagBudget>;
  readonly failurePolicy?: CollaborationDagFailurePolicy;
  readonly correlation?: BridgeIntegrationCorrelation;
}

type IntegrationRunController = Pick<
  RunController,
  "startDagRun" | "getDagRunSnapshot"
>;

export interface BridgeIntegrationDagSubmitterOptions {
  readonly registry?: RoleRegistry;
  readonly prepareParticipantsFn?: (
    config: CollaborationConfig,
    registry: RoleRegistry,
    options?: PrepareParticipantsOptions,
  ) => PreparedParticipants;
  readonly prepareOptions?: PrepareParticipantsOptions;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", `${path} must be an object`, false);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new BridgeError(
        "invalid_request",
        `${path} contains unsupported field '${key}'`,
        false,
      );
    }
  }
}

function safeId(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+\/-]*$/.test(value)
  ) {
    throw new BridgeError(
      "invalid_request",
      `${path} must be a bounded opaque identifier`,
      false,
    );
  }
  return value;
}

function builtinRoleId(value: unknown, path: string): RoleId {
  if (
    typeof value !== "string" ||
    !(BUILTIN_ROLE_IDS as readonly string[]).includes(value)
  ) {
    throw new BridgeError(
      "invalid_request",
      `${path} must name a built-in collaboration role`,
      false,
    );
  }
  return value as RoleId;
}

function optionalInteger(
  value: unknown,
  path: string,
  options: { readonly min?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const min = options.min ?? 0;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new BridgeError(
      "invalid_request",
      `${path} must be an integer >= ${min}`,
      false,
    );
  }
  return value as number;
}

function parseBudget(value: unknown): Partial<CollaborationDagBudget> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, "budget");
  exactKeys(record, [
    "maxTurns",
    "maxParticipants",
    "maxParallelTurns",
    "maxRetriesPerParticipant",
    "maxWallClockMs",
  ], "budget");

  const budget: Record<string, number> = {};
  const positive = [
    "maxTurns",
    "maxParticipants",
    "maxParallelTurns",
    "maxWallClockMs",
  ] as const;
  for (const key of positive) {
    const parsed = optionalInteger(record[key], `budget.${key}`, { min: 1 });
    if (parsed !== undefined) budget[key] = parsed;
  }
  const retries = optionalInteger(
    record.maxRetriesPerParticipant,
    "budget.maxRetriesPerParticipant",
    { min: 0 },
  );
  if (retries !== undefined) budget.maxRetriesPerParticipant = retries;
  return budget as Partial<CollaborationDagBudget>;
}

function parseCorrelation(value: unknown): BridgeIntegrationCorrelation | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, "correlation");
  exactKeys(record, [
    "arcProjectId",
    "arcTaskId",
    "arcSessionId",
    "companyWorkflowId",
    "companyStepId",
    "companyRunId",
    "externalTraceId",
  ], "correlation");

  const correlation: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new BridgeError(
        "invalid_request",
        `correlation.${key} must be a string identifier`,
        false,
      );
    }
    correlation[key] = entry;
  }
  return normalizeBridgeIntegrationCorrelation(
    correlation as BridgeIntegrationCorrelation,
  );
}

function parseParticipant(
  value: unknown,
  index: number,
): BridgeIntegrationParticipantSubmission {
  const path = `participants[${index}]`;
  const record = objectValue(value, path);
  exactKeys(record, ["roleId", "adapterType", "permissionMode"], path);

  const roleId = builtinRoleId(record.roleId, `${path}.roleId`);
  if (
    typeof record.adapterType !== "string" ||
    !record.adapterType.startsWith("acp:")
  ) {
    throw new BridgeError(
      "invalid_request",
      `${path}.adapterType must be a built-in ACP profile adapter`,
      false,
    );
  }
  const profileId = record.adapterType.slice("acp:".length);
  if (!(profileId in ACP_AGENT_PROFILES)) {
    throw new BridgeError(
      "invalid_request",
      `${path}.adapterType references an unknown ACP profile`,
      false,
    );
  }

  const permissionMode = record.permissionMode ?? "deny";
  if (permissionMode !== "deny" && permissionMode !== "allow_readonly") {
    throw new BridgeError(
      "invalid_request",
      `${path}.permissionMode must be deny or allow_readonly`,
      false,
    );
  }

  return {
    roleId,
    adapterType: record.adapterType,
    permissionMode,
  };
}

function parseNode(
  value: unknown,
  index: number,
  participantRoles: ReadonlySet<string>,
): BridgeIntegrationDagNodeSubmission {
  const path = `graph.nodes[${index}]`;
  const record = objectValue(value, path);
  exactKeys(record, [
    "id",
    "roleId",
    "instruction",
    "dependsOn",
    "terminal",
    "retryLimit",
    "timeoutMs",
  ], path);

  if (!isValidCollaborationDagNodeId(record.id)) {
    throw new BridgeError(
      "invalid_request",
      `${path}.id must match the P5 DAG node-id contract`,
      false,
    );
  }
  const roleId = builtinRoleId(record.roleId, `${path}.roleId`);
  if (!participantRoles.has(roleId)) {
    throw new BridgeError(
      "invalid_request",
      `${path}.roleId has no submitted participant binding`,
      false,
    );
  }
  if (
    typeof record.instruction !== "string" ||
    !record.instruction.trim() ||
    record.instruction.length > P5_LIMITS.maxNodeInstructionChars
  ) {
    throw new BridgeError(
      "invalid_request",
      `${path}.instruction must be non-empty and <= ${P5_LIMITS.maxNodeInstructionChars} characters`,
      false,
    );
  }
  if (
    !Array.isArray(record.dependsOn) ||
    !record.dependsOn.every(item => typeof item === "string")
  ) {
    throw new BridgeError(
      "invalid_request",
      `${path}.dependsOn must be an array of node IDs`,
      false,
    );
  }
  if (record.terminal !== undefined && typeof record.terminal !== "boolean") {
    throw new BridgeError(
      "invalid_request",
      `${path}.terminal must be boolean when provided`,
      false,
    );
  }

  return {
    id: record.id,
    roleId,
    instruction: record.instruction,
    dependsOn: [...record.dependsOn],
    terminal: record.terminal as boolean | undefined,
    retryLimit: optionalInteger(record.retryLimit, `${path}.retryLimit`, { min: 0 }),
    timeoutMs: optionalInteger(record.timeoutMs, `${path}.timeoutMs`, { min: 1 }),
  };
}

export function parseBridgeIntegrationDagSubmission(
  value: unknown,
): BridgeIntegrationDagSubmission {
  const record = objectValue(value, "request");
  exactKeys(record, [
    "schemaVersion",
    "sessionId",
    "objective",
    "participants",
    "graph",
    "budget",
    "failurePolicy",
    "correlation",
  ], "request");

  if (record.schemaVersion !== BRIDGE_INTEGRATION_SUBMISSION_SCHEMA_VERSION) {
    throw new BridgeError(
      "invalid_request",
      `schemaVersion must be ${BRIDGE_INTEGRATION_SUBMISSION_SCHEMA_VERSION}`,
      false,
    );
  }

  const sessionId = safeId(record.sessionId, "sessionId");
  if (
    typeof record.objective !== "string" ||
    !record.objective.trim() ||
    record.objective.length > BRIDGE_INTEGRATION_OBJECTIVE_MAX_CHARS
  ) {
    throw new BridgeError(
      "invalid_request",
      `objective must be non-empty and <= ${BRIDGE_INTEGRATION_OBJECTIVE_MAX_CHARS} characters`,
      false,
    );
  }

  if (
    !Array.isArray(record.participants) ||
    record.participants.length < 1 ||
    record.participants.length > 10
  ) {
    throw new BridgeError(
      "invalid_request",
      "participants must contain between 1 and 10 role bindings",
      false,
    );
  }
  const participants = record.participants.map(parseParticipant);
  const participantRoles = new Set<string>();
  for (const participant of participants) {
    if (participantRoles.has(participant.roleId)) {
      throw new BridgeError(
        "invalid_request",
        `duplicate participant role '${participant.roleId}'`,
        false,
      );
    }
    participantRoles.add(participant.roleId);
  }

  const graphRecord = objectValue(record.graph, "graph");
  exactKeys(graphRecord, ["version", "nodes"], "graph");
  if (graphRecord.version !== 1) {
    throw new BridgeError("invalid_request", "graph.version must be 1", false);
  }
  if (
    !Array.isArray(graphRecord.nodes) ||
    graphRecord.nodes.length < 1 ||
    graphRecord.nodes.length > P5_LIMITS.maxNodes
  ) {
    throw new BridgeError(
      "invalid_request",
      `graph.nodes must contain between 1 and ${P5_LIMITS.maxNodes} nodes`,
      false,
    );
  }
  const nodes = graphRecord.nodes.map((node, index) =>
    parseNode(node, index, participantRoles)
  );
  if (!nodes.some(node => node.terminal === true)) {
    throw new BridgeError(
      "invalid_request",
      "graph must declare at least one terminal node",
      false,
    );
  }

  const failurePolicy = record.failurePolicy ?? "fail_fast";
  if (failurePolicy !== "fail_fast" && failurePolicy !== "skip_dependents") {
    throw new BridgeError(
      "invalid_request",
      "failurePolicy must be fail_fast or skip_dependents",
      false,
    );
  }

  return {
    schemaVersion: 1,
    sessionId,
    objective: record.objective,
    participants,
    graph: {
      version: 1,
      nodes,
    },
    budget: parseBudget(record.budget),
    failurePolicy,
    correlation: parseCorrelation(record.correlation),
  };
}

export function createBridgeIntegrationDagSubmitter(
  runController: IntegrationRunController,
  options: BridgeIntegrationDagSubmitterOptions = {},
): (input: unknown) => Promise<BridgeIntegrationDagRunProjection> {
  const registry = options.registry ?? createBuiltinRoleRegistry();
  const prepare = options.prepareParticipantsFn ?? prepareParticipants;

  return async input => {
    const request = parseBridgeIntegrationDagSubmission(input);
    const roles: RoleAssignment[] = request.participants.map(participant => ({
      roleId: participant.roleId,
      participantConfig: {
        adapterType: participant.adapterType,
        config: {
          permissionMode: participant.permissionMode,
        },
      },
    }));

    const terminalRoles = [...new Set(
      request.graph.nodes
        .filter(node => node.terminal === true)
        .map(node => node.roleId),
    )];

    const {
      maxParallelTurns: _ignoredParallelism,
      ...p4Budget
    } = request.budget ?? {};
    const maxParticipants =
      request.budget?.maxParticipants ?? request.participants.length;

    const config: CollaborationConfig = {
      objective: request.objective,
      policy: {
        roleSequence: request.participants.map(participant => participant.roleId),
        loopMode: "once",
        terminalRoles,
      },
      roles,
      budget: {
        ...p4Budget,
        maxParticipants,
      },
    };

    const prepared = prepare(config, registry, options.prepareOptions);
    const participantByRole = new Map(
      prepared.plans.map(plan => [plan.roleId, plan.participantId]),
    );

    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: request.graph.nodes.map(node => {
        const participantId = participantByRole.get(node.roleId);
        if (!participantId) {
          throw new BridgeError(
            "invalid_request",
            `No prepared participant exists for role '${node.roleId}'`,
            false,
          );
        }
        return {
          id: node.id,
          participantId,
          instruction: node.instruction,
          dependsOn: [...node.dependsOn],
          terminal: node.terminal,
          retryLimit: node.retryLimit,
          timeoutMs: node.timeoutMs,
        };
      }),
    };

    const dagBudget: Partial<CollaborationDagBudget> = {
      ...(request.budget ?? {}),
      maxParticipants,
    };

    const run = await runController.startDagRun(
      request.sessionId,
      config,
      prepared,
      graph,
      {
        budget: dagBudget,
        failurePolicy: request.failurePolicy,
        correlation: request.correlation,
      },
    );

    const snapshot = runController.getDagRunSnapshot(run.id);
    if (!snapshot) {
      throw new BridgeError(
        "persistence_corruption",
        `DAG run '${run.id}' was created without a readable persisted snapshot`,
        false,
      );
    }
    return createBridgeIntegrationDagRunProjection(snapshot);
  };
}
