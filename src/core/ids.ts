import crypto from "node:crypto";

export function generateId(prefix: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}_${uuid}`;
}

export function generateSessionId(): string {
  return generateId("ses");
}

export function generateTurnId(): string {
  return generateId("turn");
}

export function generateRunId(): string {
  return generateId("run");
}

export function generateParticipantId(): string {
  return generateId("part");
}

export function generateCollaborationTurnId(): string {
  return generateId("cturn");
}
