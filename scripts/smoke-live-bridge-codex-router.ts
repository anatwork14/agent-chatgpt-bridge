import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { bridgeApiToken, resolveBridgePort } from "../src/runtime/bridge-runtime";

interface JsonRecord {
  [key: string]: unknown;
}

const routerBaseUrl = process.env.AGENT_CHATGPT_CODEX_ROUTER_BASE_URL?.trim();
if (!routerBaseUrl) {
  throw new Error("AGENT_CHATGPT_CODEX_ROUTER_BASE_URL is required for the live bridge smoke");
}

const requestTimeoutMs = Number(process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_TIMEOUT_MS || "120000");
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
  throw new Error("AGENT_CHATGPT_CODEX_ROUTER_SMOKE_TIMEOUT_MS must be an integer >= 1000");
}

const cancellationDelayMs = Number(process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL_DELAY_MS || "500");
if (!Number.isSafeInteger(cancellationDelayMs) || cancellationDelayMs < 0) {
  throw new Error("AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL_DELAY_MS must be a non-negative integer");
}

const config = loadConfig();
const bridgePort = resolveBridgePort();
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}/bridge/v1`;
const apiToken = bridgeApiToken(config);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const marker = `BRIDGE_ROUTER_SMOKE_${suffix.toUpperCase()}`;

let capabilityPath = "";
let decodedCapabilityPath = "";
try {
  const parsed = new URL(routerBaseUrl);
  capabilityPath = parsed.pathname.replace(/\/$/, "");
  try {
    decodedCapabilityPath = decodeURIComponent(capabilityPath);
  } catch {
    decodedCapabilityPath = capabilityPath;
  }
} catch {
  throw new Error("AGENT_CHATGPT_CODEX_ROUTER_BASE_URL must be an absolute URL");
}

function assertNoCapabilityLeak(text: string): void {
  const leaked = text.includes(routerBaseUrl)
    || (capabilityPath.length > 1 && text.includes(capabilityPath))
    || (decodedCapabilityPath.length > 1 && text.includes(decodedCapabilityPath));
  if (leaked) {
    throw new Error("Bridge response exposed codex-router capability URL material");
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

async function bridgeJson(path: string, init: RequestInit = {}): Promise<JsonRecord | unknown[]> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiToken}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${bridgeBaseUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertNoCapabilityLeak(message);
    throw new Error(`Could not reach the running Agent ChatGPT Bridge on port ${bridgePort}: ${message}`);
  }

  const text = await response.text();
  assertNoCapabilityLeak(text);
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Bridge ${path} returned non-JSON data with HTTP ${response.status}`);
    }
  }

  if (!response.ok) {
    const error = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
    const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
    const message = typeof error?.message === "string" ? error.message : "Bridge request failed";
    assertNoCapabilityLeak(message);
    throw new Error(`Bridge ${path} failed (${code}): ${message}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(`Bridge ${path} returned an invalid JSON payload`);
  }
  return payload as JsonRecord | unknown[];
}

function modelsFrom(value: JsonRecord | unknown[]): string[] {
  const payload = record(value, "model response");
  const models = payload.models;
  if (!Array.isArray(models) || !models.every(model => typeof model === "string")) {
    throw new Error("Bridge /models response has no string model list");
  }
  return models;
}

function sessionIdFrom(value: JsonRecord | unknown[]): string {
  const session = record(value, "session");
  if (typeof session.id !== "string" || !session.id) throw new Error("Bridge session response has no id");
  return session.id;
}

function assistantText(value: JsonRecord | unknown[]): string {
  const response = record(value, "turn response");
  if (response.status !== "completed") {
    const error = response.error && typeof response.error === "object" && !Array.isArray(response.error)
      ? response.error as { code?: unknown; message?: unknown }
      : undefined;
    const code = typeof error?.code === "string" ? error.code : "turn_not_completed";
    const message = typeof error?.message === "string" ? error.message : `status=${String(response.status)}`;
    assertNoCapabilityLeak(message);
    throw new Error(`Routed turn did not complete (${code}): ${message}`);
  }
  const message = record(response.message, "turn message");
  if (!Array.isArray(message.content)) throw new Error("Turn response message has no content array");
  return message.content
    .map(part => part && typeof part === "object" && !Array.isArray(part)
      ? (part as { type?: unknown; text?: unknown })
      : undefined)
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part))
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("");
}

async function createSession(model: string, name: string): Promise<{ id: string; provider?: string }> {
  const payload = await bridgeJson("/sessions", {
    method: "POST",
    body: JSON.stringify({ name, model }),
  });
  const session = record(payload, "created session");
  if (session.model !== model) {
    throw new Error(`Bridge created session with unexpected model ${String(session.model)}`);
  }
  return {
    id: sessionIdFrom(payload),
    provider: typeof session.provider === "string" ? session.provider : undefined,
  };
}

async function sendTurn(sessionId: string, text: string): Promise<JsonRecord | unknown[]> {
  return bridgeJson(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: [{ type: "text", text }],
      stream: false,
    }),
  });
}

async function closeSession(sessionId: string): Promise<void> {
  await bridgeJson(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

await bridgeJson("/healthz");
const models = modelsFrom(await bridgeJson("/models"));
const requestedModel = process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_MODEL?.trim();
const routerModel = requestedModel || models.find(model => model.startsWith("codex-router/"));
if (!routerModel) {
  throw new Error("The running bridge exposes no codex-router/... model");
}
if (!models.includes(routerModel)) {
  throw new Error(`Requested live smoke model is not exposed by the bridge: ${routerModel}`);
}

const chatgptModels = models.filter(model => model.startsWith("chatgpt-web/"));
if (chatgptModels.length === 0) {
  throw new Error("The running bridge exposes no chatgpt-web/... model while codex-router is enabled");
}

const routed = await createSession(routerModel, `router-live-smoke-${suffix}`);
try {
  const first = await sendTurn(
    routed.id,
    `Remember this exact marker for the next turn: ${marker}. Reply with the marker.`,
  );
  const firstText = assistantText(first);
  if (!firstText.includes(marker)) {
    throw new Error("First routed turn completed but did not return the requested continuity marker");
  }

  const second = await sendTurn(
    routed.id,
    "What exact marker did I ask you to remember in the immediately previous turn? Reply with that marker.",
  );
  const secondText = assistantText(second);
  if (!secondText.includes(marker)) {
    throw new Error("Second routed turn did not demonstrate same-session conversation continuity");
  }

  const persisted = record(
    await bridgeJson(`/sessions/${encodeURIComponent(routed.id)}`),
    "persisted routed session",
  );
  if (persisted.model !== routerModel || (routed.provider && persisted.provider !== routed.provider)) {
    throw new Error("Routed session provider/model identity changed across turns");
  }

  const transcript = await bridgeJson(`/sessions/${encodeURIComponent(routed.id)}/messages`);
  if (!Array.isArray(transcript)) throw new Error("Routed session transcript is not an array");
  const roles = transcript
    .map(message => message && typeof message === "object" && !Array.isArray(message)
      ? (message as { role?: unknown }).role
      : undefined)
    .filter((role): role is string => typeof role === "string");
  if (roles.length < 4 || roles.slice(-4).join(",") !== "user,assistant,user,assistant") {
    throw new Error(`Unexpected routed transcript role sequence: ${roles.join(",")}`);
  }
} finally {
  await closeSession(routed.id).catch(() => undefined);
}

let cancellation = "not-requested";
if (process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL === "1") {
  const cancelSession = await createSession(routerModel, `router-cancel-smoke-${suffix}`);
  try {
    const cancellationPrompt = process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL_PROMPT?.trim()
      || "Produce a long, detailed numbered explanation with at least 1500 words. Do not summarize or stop early.";
    const pending = sendTurn(cancelSession.id, cancellationPrompt);
    await Bun.sleep(cancellationDelayMs);
    const cancelPayload = record(
      await bridgeJson(`/sessions/${encodeURIComponent(cancelSession.id)}/cancel`, { method: "POST" }),
      "cancellation response",
    );
    if (cancelPayload.cancelled !== true) {
      throw new Error("Cancellation smoke did not find an active routed turn; use a slower model or a longer cancellation prompt");
    }
    const cancelledTurn = record(await pending, "cancelled turn response");
    if (cancelledTurn.status !== "cancelled") {
      throw new Error(`Routed request cancellation returned unexpected status ${String(cancelledTurn.status)}`);
    }
    cancellation = "passed";
  } finally {
    await closeSession(cancelSession.id).catch(() => undefined);
  }
}

let coexistence = "model-discovery-only";
if (process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT === "1") {
  const requestedChatGptModel = process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT_MODEL?.trim();
  const chatgptModel = requestedChatGptModel || chatgptModels[0]!;
  if (!models.includes(chatgptModel) || !chatgptModel.startsWith("chatgpt-web/")) {
    throw new Error(`Requested ChatGPT Web smoke model is not exposed by the bridge: ${chatgptModel}`);
  }
  const chatgpt = await createSession(chatgptModel, `chatgpt-live-smoke-${suffix}`);
  try {
    const reply = assistantText(await sendTurn(
      chatgpt.id,
      "Reply with a short acknowledgement for a provider-coexistence smoke test.",
    ));
    if (!reply.trim()) throw new Error("ChatGPT Web coexistence turn completed without assistant text");
    const persisted = record(
      await bridgeJson(`/sessions/${encodeURIComponent(chatgpt.id)}`),
      "persisted ChatGPT Web session",
    );
    if (persisted.model !== chatgptModel || (chatgpt.provider && persisted.provider !== chatgpt.provider)) {
      throw new Error("ChatGPT Web session provider/model identity changed during coexistence smoke");
    }
    coexistence = "passed";
  } finally {
    await closeSession(chatgpt.id).catch(() => undefined);
  }
}

process.stdout.write(
  `LIVE_BRIDGE_CODEX_ROUTER_SMOKE_OK model=${routerModel} continuity=passed capability_leak=none cancellation=${cancellation} coexistence=${coexistence}\n`,
);
