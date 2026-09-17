import { createHash } from "node:crypto";
import type { RoleId } from "./collaboration-domain";
import type { PriorCollaborationTurn } from "./domain";
import { BridgeError } from "./errors";

/**
 * Maximum permitted size in UTF-8 bytes for a single canonical collaboration message.
 * Guardrail against unbounded model output flooding SQLite.
 */
export const MAX_COLLABORATION_MESSAGE_BYTES = 1_000_000; // 1 MB

/**
 * Pure, serializable record of an immutable participant output in the canonical collaboration transcript.
 * Contains no adapter handles, session objects, or provider credentials.
 */
export interface CollaborationMessageRecord {
  readonly id: string;
  readonly runId: string;
  readonly turnId: string;
  readonly sequenceIndex: number;
  readonly senderParticipantId: string;
  readonly senderRoleId: RoleId;
  readonly decisionType: "message" | "done" | "pause" | "error";
  readonly content: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

/**
 * Canonical text normalization:
 * - Unicode normalization form C (NFC)
 * - Standardize CRLF and CR to LF
 *
 * Preserves all meaningful indentation, code structure, punctuation, and markdown intact.
 */
export function normalizeCanonicalText(text: string): string {
  return text.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Enforces fail-closed size bounds on canonical participant messages before hashing or persisting.
 */
export function assertMessageWithinSizeBound(content: string): void {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_COLLABORATION_MESSAGE_BYTES) {
    throw new BridgeError(
      "collaboration_message_too_large",
      `Collaboration message size (${byteLength} bytes) exceeds maximum allowed bound (${MAX_COLLABORATION_MESSAGE_BYTES} bytes)`,
      false,
    );
  }
}

/**
 * Deterministically computes the SHA-256 integrity hash for a collaboration message,
 * cryptographically binding content and provenance together.
 */
export function computeCollaborationMessageHash(params: {
  readonly runId: string;
  readonly turnId: string;
  readonly participantId: string;
  readonly roleId: string;
  readonly decisionType: string;
  readonly content: string;
}): string {
  const normalizedContent = normalizeCanonicalText(params.content);
  const payload = [
    params.runId,
    params.turnId,
    params.participantId,
    params.roleId,
    params.decisionType,
    normalizedContent,
  ].join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Verifies that a persisted collaboration message matches its cryptographic integrity hash.
 */
export function verifyCollaborationMessage(message: CollaborationMessageRecord): boolean {
  const expectedHash = computeCollaborationMessageHash({
    runId: message.runId,
    turnId: message.turnId,
    participantId: message.senderParticipantId,
    roleId: message.senderRoleId,
    decisionType: message.decisionType,
    content: message.content,
  });
  return message.contentHash === expectedHash;
}

/**
 * Asserts cryptographic integrity of a collaboration message. Fails closed if tampered.
 */
export function assertCollaborationMessageIntegrity(message: CollaborationMessageRecord): void {
  if (!verifyCollaborationMessage(message)) {
    throw new BridgeError(
      "collaboration_transcript_integrity_failed",
      `Collaboration transcript integrity check failed for message '${message.id}' (turn '${message.turnId}', run '${message.runId}')`,
      false,
    );
  }
}

/**
 * Pure projection transforming canonical collaboration messages into subsequent turn inputs (priorTurns).
 */
export function collaborationMessagesToPriorTurns(
  messages: readonly CollaborationMessageRecord[],
): PriorCollaborationTurn[] {
  return messages.map((m) => ({
    participantId: m.senderParticipantId,
    roleId: m.senderRoleId,
    decisionType: m.decisionType,
    text: m.content,
  }));
}
