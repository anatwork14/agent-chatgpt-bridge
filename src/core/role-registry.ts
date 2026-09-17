import {
  type RoleId,
  type RoleDefinition,
} from "./collaboration-domain";
import { validateRoleDefinition } from "./collaboration-validation";
import { BUILTIN_ROLE_DEFINITIONS } from "./builtin-roles";
import { BridgeError } from "./errors";

export class RoleRegistryError extends BridgeError {
  constructor(
    code: "invalid_role_definition" | "duplicate_role" | "role_not_found",
    message: string,
    public readonly roleId?: string,
  ) {
    super(code, message, false);
    this.name = "RoleRegistryError";
  }
}

/**
 * Recursively freezes an object and all nested object properties.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Deeply clones a serializable data structure using structuredClone.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * In-memory deterministic registry for logical role definitions.
 *
 * Guarantees:
 * 1. Strict validation: No malformed role definition can enter the registry.
 * 2. Uniqueness: Duplicate role registrations are rejected with a structured error.
 * 3. Immutability: Stored definitions cannot be modified by callers mutating input or output objects.
 * 4. Deterministic ordering: Preserves exact registration insertion order.
 * 5. Provider independence: Does not know about models, providers, ACP, processes, or runtimes.
 */
export class RoleRegistry {
  private readonly roles = new Map<RoleId, Readonly<RoleDefinition>>();

  constructor(definitions?: readonly RoleDefinition[]) {
    if (definitions) {
      for (const def of definitions) {
        this.register(def);
      }
    }
  }

  /**
   * Registers a new role definition.
   * Validates the definition, verifies uniqueness, and creates an immutable deep snapshot.
   *
   * @throws {RoleRegistryError} if the definition is invalid or already registered
   */
  register(definition: RoleDefinition): void {
    if (!definition || typeof definition !== "object") {
      throw new RoleRegistryError(
        "invalid_role_definition",
        "Role definition must be a non-null object",
      );
    }

    const issues = validateRoleDefinition(definition);
    if (issues.length > 0) {
      const detail = issues.map(i => `${i.path}: [${i.code}] ${i.message}`).join("; ");
      throw new RoleRegistryError(
        "invalid_role_definition",
        `Cannot register invalid role definition: ${detail}`,
        (definition as any)?.id,
      );
    }

    if (this.roles.has(definition.id)) {
      throw new RoleRegistryError(
        "duplicate_role",
        `Role '${definition.id}' is already registered in this registry`,
        definition.id,
      );
    }

    // Take an isolated deep snapshot and deep-freeze it to guarantee complete immutability
    const snapshot = deepFreeze(deepClone(definition));
    this.roles.set(definition.id, snapshot);
  }

  /**
   * Checks if a role ID is registered.
   */
  has(roleId: RoleId): boolean {
    return this.roles.has(roleId);
  }

  /**
   * Retrieves a role definition by ID, or undefined if not found.
   * The returned definition is deeply frozen and cannot be mutated.
   */
  get(roleId: RoleId): Readonly<RoleDefinition> | undefined {
    return this.roles.get(roleId);
  }

  /**
   * Retrieves a role definition by ID or throws if not found.
   *
   * @throws {RoleRegistryError} with code 'role_not_found'
   */
  require(roleId: RoleId): Readonly<RoleDefinition> {
    const role = this.roles.get(roleId);
    if (!role) {
      throw new RoleRegistryError(
        "role_not_found",
        `Role '${roleId}' is not registered in this registry`,
        roleId,
      );
    }
    return role;
  }

  /**
   * Returns all registered role definitions in their deterministic registration order.
   * The returned array is a fresh frozen copy containing deeply frozen role definitions.
   */
  list(): readonly Readonly<RoleDefinition>[] {
    return Object.freeze([...this.roles.values()]);
  }

  /**
   * Returns all registered role IDs in their deterministic registration order.
   */
  ids(): readonly RoleId[] {
    return Object.freeze([...this.roles.keys()]);
  }
}

/**
 * Creates an independent RoleRegistry pre-populated with all canonical built-in roles.
 * Each invocation returns an isolated registry instance to prevent global mutable state leakage.
 */
export function createBuiltinRoleRegistry(): RoleRegistry {
  return new RoleRegistry(BUILTIN_ROLE_DEFINITIONS);
}
