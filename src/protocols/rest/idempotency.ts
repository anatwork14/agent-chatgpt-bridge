import { createHash } from "node:crypto";
import { BridgeError } from "../../core/errors";
import { IdempotencyStore } from "../../persistence/idempotency-store";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input).sort().map(key => [key, canonicalize(input[key])]),
  );
}

export function idempotencyBodyHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("base64url");
}

export function validateIdempotencyKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new BridgeError(
      "invalid_request",
      "Idempotency-Key must be 1-200 characters using letters, digits, dot, underscore, colon, or hyphen",
      false,
    );
  }
  return key;
}

export async function executeIdempotent<T>(
  store: IdempotencyStore,
  scope: string,
  key: string | undefined,
  body: unknown,
  operation: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const validated = validateIdempotencyKey(key);
  if (!validated) return { value: await operation(), replayed: false };

  const scopedKey = `${scope}:${validated}`;
  const bodyHash = idempotencyBodyHash(body);
  const reservation = store.reserve(scopedKey, bodyHash);

  if (reservation.status === "existing") {
    if (reservation.record.bodyHash !== bodyHash) {
      throw new BridgeError(
        "idempotency_conflict",
        "The Idempotency-Key was already used with a different request body",
        false,
      );
    }
    if (!reservation.record.resultJson) {
      throw new BridgeError(
        "idempotency_in_progress",
        "A request with this Idempotency-Key is already in progress",
        true,
      );
    }
    try {
      return { value: JSON.parse(reservation.record.resultJson) as T, replayed: true };
    } catch {
      throw new BridgeError(
        "idempotency_corrupt",
        "Stored idempotency result is invalid; refusing to repeat the side effect",
        false,
      );
    }
  }

  let value: T;
  try {
    value = await operation();
  } catch (error) {
    store.release(scopedKey, bodyHash);
    throw error;
  }
  // If persistence of a successful result fails, retain the incomplete reservation rather than
  // releasing it and risking a duplicate side effect on retry.
  store.complete(scopedKey, bodyHash, value);
  return { value, replayed: false };
}
