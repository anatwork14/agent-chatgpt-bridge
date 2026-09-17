import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BridgeContentPart, BridgeEnvironment, BridgeMessage } from "./domain";
import { BridgeError } from "./errors";

const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 32 * 1024 * 1024;

function normalizedPath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(normalizedPath(root), normalizedPath(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowedRoots(environment?: BridgeEnvironment): string[] {
  const configured = [
    ...(environment?.workspaceRoots ?? []),
    ...(environment?.cwd ? [environment.cwd] : []),
  ];
  const roots: string[] = [];
  for (const root of configured) {
    if (!isAbsolute(root)) {
      throw new BridgeError(
        "attachment_invalid",
        `Attachment workspace root must be absolute: ${root}`,
        false,
      );
    }
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch {
      throw new BridgeError(
        "attachment_invalid",
        `Attachment workspace root does not exist: ${root}`,
        false,
      );
    }
    if (!roots.some(existing => normalizedPath(existing) === normalizedPath(canonical))) {
      roots.push(canonical);
    }
  }
  return roots;
}

function validateDataUrl(dataUrl: string): void {
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    throw new BridgeError(
      "attachment_invalid",
      `Image data URL exceeds the ${MAX_DATA_URL_CHARS} character safety limit`,
      false,
    );
  }
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl)) {
    throw new BridgeError(
      "attachment_invalid",
      "Image data URLs must use a base64-encoded image MIME type",
      false,
    );
  }
}

function canonicalLocalFile(path: string, environment?: BridgeEnvironment): string {
  const roots = allowedRoots(environment);
  if (roots.length === 0) {
    throw new BridgeError(
      "attachment_invalid",
      "Local-file attachments require an explicit absolute cwd or workspaceRoots allowlist",
      false,
    );
  }

  const base = environment?.cwd ?? roots[0]!;
  const candidate = isAbsolute(path) ? path : resolve(base, path);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new BridgeError("attachment_invalid", `Local attachment does not exist: ${path}`, false);
  }

  if (!roots.some(root => inside(root, canonical))) {
    throw new BridgeError(
      "attachment_invalid",
      `Local attachment is outside the allowed workspace roots: ${path}`,
      false,
    );
  }

  let stat;
  try {
    stat = statSync(canonical);
  } catch {
    throw new BridgeError("attachment_invalid", `Could not inspect local attachment: ${path}`, false);
  }
  if (!stat.isFile()) {
    throw new BridgeError("attachment_invalid", `Local attachment is not a regular file: ${path}`, false);
  }
  if (stat.size > MAX_LOCAL_FILE_BYTES) {
    throw new BridgeError(
      "attachment_invalid",
      `Local attachment exceeds the ${MAX_LOCAL_FILE_BYTES} byte safety limit: ${path}`,
      false,
    );
  }
  return canonical;
}

export function validateBridgeContentPart(
  part: BridgeContentPart,
  environment?: BridgeEnvironment,
): BridgeContentPart {
  if (part.type === "text") return part;
  if (part.type === "image") {
    if (part.source.type === "data_url") {
      validateDataUrl(part.source.dataUrl);
      return part;
    }
    return {
      ...part,
      source: {
        type: "local_file",
        path: canonicalLocalFile(part.source.path, environment),
      },
    };
  }
  if (part.type === "resource") {
    let parsed: URL;
    try {
      parsed = new URL(part.uri);
    } catch {
      throw new BridgeError("attachment_invalid", `Resource URI is invalid: ${part.uri}`, false);
    }
    if (parsed.protocol !== "https:") {
      throw new BridgeError(
        "attachment_invalid",
        `Only HTTPS resource URIs are accepted; received ${parsed.protocol}`,
        false,
      );
    }
    return part;
  }
  const exhaustive: never = part;
  return exhaustive;
}

export function validateBridgeMessage(
  message: BridgeMessage,
  environment?: BridgeEnvironment,
): BridgeMessage {
  return {
    ...message,
    content: message.content.map(part => validateBridgeContentPart(part, environment)),
  };
}

export function validateBridgeMessages(
  messages: BridgeMessage[],
  environment?: BridgeEnvironment,
): BridgeMessage[] {
  return messages.map(message => validateBridgeMessage(message, environment));
}

export function validateBridgeAttachments(
  attachments: BridgeContentPart[] | undefined,
  environment?: BridgeEnvironment,
): BridgeContentPart[] | undefined {
  return attachments?.map(part => validateBridgeContentPart(part, environment));
}
