import type {
  BridgeContentPart,
  BridgeMessage,
  BridgeTurnRequest,
  BridgeTurnResult,
  BridgeUsage,
} from "../../core/domain";
import type { BridgeEvent } from "../../core/events";
import { BridgeError } from "../../core/errors";
import type { ConversationProvider, ProviderCapabilities } from "../provider";

export const CODEX_ROUTER_PROVIDER_NAME = "codex-router";
export const CODEX_ROUTER_MODEL_PREFIX = `${CODEX_ROUTER_PROVIDER_NAME}/`;

export interface CodexRouterProviderOptions {
  /** Full OpenAI-compatible base URL, normally the router's caller-capability URL ending in /v1. */
  baseUrl: string;
  /** Optional bearer token for deployments that place an additional local auth layer in front of the router. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Remote endpoints are intentionally disabled by default; codex-router is a local provider plane. */
  allowRemote?: boolean;
}

interface SseEvent {
  event?: string;
  data: string;
}

interface RouterResponseObject {
  id?: string;
  status?: string;
  output?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string;
    message?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
}

function normalizeBaseUrl(value: string, allowRemote = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BridgeError("invalid_request", "Codex Router base URL must be an absolute HTTP(S) URL", false);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeError("invalid_request", "Codex Router base URL must use HTTP or HTTPS", false);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BridgeError(
      "invalid_request",
      "Codex Router base URL must not contain credentials, query parameters, or fragments",
      false,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (!allowRemote && !loopback) {
    throw new BridgeError(
      "invalid_request",
      "Codex Router endpoint must be loopback unless allowRemote is explicitly enabled",
      false,
    );
  }
  if (parsed.protocol === "http:" && !loopback) {
    throw new BridgeError("invalid_request", "Remote Codex Router endpoints must use HTTPS", false);
  }

  return parsed.toString().replace(/\/$/, "");
}

function publicModelId(routerModelId: string): string {
  return `${CODEX_ROUTER_MODEL_PREFIX}${routerModelId}`;
}

function upstreamModelId(publicId: string): string {
  if (!publicId.startsWith(CODEX_ROUTER_MODEL_PREFIX)) {
    throw new BridgeError(
      "model_unavailable",
      `Codex Router model must use the ${CODEX_ROUTER_MODEL_PREFIX}<model> namespace`,
      false,
    );
  }
  const value = publicId.slice(CODEX_ROUTER_MODEL_PREFIX.length);
  if (!value) {
    throw new BridgeError("model_unavailable", "Codex Router model id is empty", false);
  }
  return value;
}

function textOnly(parts: BridgeContentPart[], label: string): string[] {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      throw new BridgeError(
        "provider_capability_unsupported",
        `Codex Router provider currently supports text-only ${label}; received ${part.type}`,
        false,
      );
    }
    texts.push(part.text);
  }
  return texts;
}

function responseInputMessage(message: BridgeMessage): Record<string, unknown> {
  if (message.role === "tool") {
    throw new BridgeError(
      "provider_capability_unsupported",
      "Codex Router provider does not yet translate tool-result history",
      false,
    );
  }
  const texts = textOnly(message.content, `${message.role} messages`);
  if (message.role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      status: "completed",
      content: texts.map(text => ({ type: "output_text", text, annotations: [] })),
    };
  }
  return {
    type: "message",
    role: message.role,
    content: texts.map(text => ({ type: "input_text", text })),
  };
}

function bridgeUsage(value: RouterResponseObject["usage"]): BridgeUsage | undefined {
  if (!value) return undefined;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens
      ?? ((value.input_tokens ?? 0) + (value.output_tokens ?? 0)),
  };
}

function outputText(response: RouterResponseObject): string {
  let text = "";
  for (const item of response.output ?? []) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = part as { type?: unknown; text?: unknown };
      if (value.type === "output_text" && typeof value.text === "string") text += value.text;
    }
  }
  return text;
}

/**
 * codex-router's caller capability is carried in the URL path. Transport stacks and upstream
 * diagnostics occasionally include request URLs in error messages, so no raw provider message may
 * cross the bridge boundary before the endpoint path has been redacted.
 */
function redactEndpointDetails(message: string, baseUrl: string): string {
  let redacted = message.split(baseUrl).join("[codex-router-endpoint]");
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/$/, "");
    if (pathname && pathname !== "/" && pathname !== "/v1") {
      redacted = redacted.split(pathname).join("/[codex-router-capability]");
      try {
        redacted = redacted.split(decodeURIComponent(pathname)).join("/[codex-router-capability]");
      } catch {
        // The URL parser already accepted the path; a malformed percent escape cannot expose more
        // than the original path, which was replaced above.
      }
    }
  } catch {
    // Constructor validation owns URL validity. Keep this function total for defensive callers.
  }
  return redacted;
}

function errorFromHttp(status: number, payload: unknown, baseUrl: string): BridgeError {
  let message = `Codex Router request failed with HTTP ${status}`;
  let upstreamCode: string | undefined;
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const raw = error as { message?: unknown; code?: unknown };
      if (typeof raw.message === "string" && raw.message.trim()) message = raw.message;
      if (typeof raw.code === "string" && raw.code.trim()) upstreamCode = raw.code;
    }
  }
  message = redactEndpointDetails(message, baseUrl);
  if (status === 401 || status === 403) {
    return new BridgeError("provider_authentication_failed", message, false);
  }
  if (status === 429) {
    return new BridgeError("provider_rate_limited", message, true);
  }
  if (status >= 500) {
    return new BridgeError("provider_unavailable", message, true);
  }
  return new BridgeError(upstreamCode || "provider_request_failed", message, false);
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 1_000) } };
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = (frame: string) => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length > 0) onEvent({ event, data: data.join("\n") });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consumeFrame(frame);
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) consumeFrame(buffer);
}

function requestBody(request: BridgeTurnRequest): Record<string, unknown> {
  if (request.tools && request.tools.length > 0) {
    throw new BridgeError(
      "provider_capability_unsupported",
      "Codex Router provider tool translation is not enabled yet",
      false,
    );
  }

  const body: Record<string, unknown> = {
    model: upstreamModelId(request.model.model),
    input: request.messages.map(responseInputMessage),
    stream: true,
  };
  if (request.model.effort) body.reasoning = { effort: request.model.effort };
  if (request.output?.type === "json_schema") {
    if (!request.output.schema) {
      throw new BridgeError("invalid_request", "json_schema output requires schema", false);
    }
    body.text = {
      format: {
        type: "json_schema",
        name: "bridge_output",
        schema: request.output.schema,
      },
    };
  }
  return body;
}

export class CodexRouterConversationProvider implements ConversationProvider {
  public readonly name = CODEX_ROUTER_PROVIDER_NAME;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodexRouterProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowRemote === true);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(accept?: string): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (accept) headers.set("accept", accept);
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    return headers;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.headers("application/json"),
      });
    } catch {
      throw new BridgeError(
        "provider_unavailable",
        "Could not reach Codex Router",
        true,
      );
    }
    if (!response.ok) throw errorFromHttp(response.status, await safeJson(response), this.baseUrl);
    const payload = await safeJson(response);
    const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) {
      throw new BridgeError("provider_protocol_invalid", "Codex Router /models response has no data array", false);
    }
    const models = data
      .map(value => value && typeof value === "object" ? (value as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map(publicModelId);
    return {
      // Capabilities vary per routed model. Stay conservative until model-level capability metadata is wired.
      supportsImages: false,
      supportsTools: false,
      models,
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: { signal?: AbortSignal; emit(event: BridgeEvent): void },
  ): Promise<BridgeTurnResult> {
    const turnId = request.requestId;
    const result: BridgeTurnResult = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId,
      status: "incomplete",
      text: "",
    };
    let terminalSeen = false;

    ctx.emit({ type: "turn.started", sessionId: request.sessionId, turnId });

    const fail = (
      status: "failed" | "cancelled" | "incomplete",
      code: string,
      message: string,
      retryable: boolean,
    ) => {
      if (terminalSeen) return;
      terminalSeen = true;
      result.status = status;
      result.error = { code, message: redactEndpointDetails(message, this.baseUrl), retryable };
      ctx.emit({
        type: "turn.failed",
        sessionId: request.sessionId,
        turnId,
        error: result.error,
      });
    };

    const completeFromResponse = (response: RouterResponseObject) => {
      if (terminalSeen) return;
      const status = response.status;
      if (status === "completed" || !status) {
        terminalSeen = true;
        result.status = "completed";
        if (!result.text) result.text = outputText(response);
        result.usage = bridgeUsage(response.usage);
        result.providerMetadata = { responseId: response.id };
        ctx.emit({ type: "turn.completed", sessionId: request.sessionId, turnId, result });
        return;
      }
      if (status === "incomplete") {
        result.usage = bridgeUsage(response.usage);
        fail(
          "incomplete",
          "provider_incomplete",
          response.incomplete_details?.reason || "Codex Router response was incomplete",
          false,
        );
        return;
      }
      if (status === "failed" || status === "cancelled") {
        fail(
          status === "cancelled" ? "cancelled" : "failed",
          response.error?.code || (status === "cancelled" ? "client_cancelled" : "provider_failed"),
          response.error?.message || `Codex Router response ended with status ${status}`,
          false,
        );
      }
    };

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: this.headers("text/event-stream"),
        body: JSON.stringify(requestBody(request)),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const error = errorFromHttp(response.status, await safeJson(response), this.baseUrl);
        fail("failed", error.code, error.message, error.retryable);
        return result;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const payload = await safeJson(response);
        if (!payload || typeof payload !== "object") {
          fail("failed", "provider_protocol_invalid", "Codex Router returned an empty response", false);
        } else {
          completeFromResponse(payload as RouterResponseObject);
        }
      } else if (!response.body) {
        fail("failed", "provider_protocol_invalid", "Codex Router SSE response has no body", false);
      } else {
        await consumeSse(response.body, frame => {
          if (terminalSeen || frame.data === "[DONE]") return;
          let payload: any;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            fail("failed", "provider_protocol_invalid", "Codex Router emitted malformed SSE JSON", false);
            return;
          }
          const type = typeof payload?.type === "string" ? payload.type : frame.event;
          switch (type) {
            case "response.output_text.delta":
              if (typeof payload.delta === "string") {
                result.text += payload.delta;
                ctx.emit({ type: "text.delta", sessionId: request.sessionId, turnId, delta: payload.delta });
              }
              break;
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_summary.delta":
              if (typeof payload.delta === "string") {
                ctx.emit({
                  type: "reasoning.summary.delta",
                  sessionId: request.sessionId,
                  turnId,
                  delta: payload.delta,
                });
              }
              break;
            case "response.completed":
              completeFromResponse((payload.response ?? payload) as RouterResponseObject);
              break;
            case "response.incomplete":
              completeFromResponse({ ...(payload.response ?? payload), status: "incomplete" });
              break;
            case "response.failed":
              completeFromResponse({ ...(payload.response ?? payload), status: "failed" });
              break;
            case "error": {
              const error = payload.error ?? payload;
              fail(
                "failed",
                typeof error.code === "string" ? error.code : "provider_error",
                typeof error.message === "string" ? error.message : "Codex Router emitted an error event",
                false,
              );
              break;
            }
          }
        });
      }

      if (!terminalSeen) {
        fail(
          ctx.signal?.aborted ? "cancelled" : "failed",
          ctx.signal?.aborted ? "client_cancelled" : "provider_terminal_missing",
          ctx.signal?.aborted
            ? "Codex Router turn was cancelled"
            : "Codex Router stream ended without a terminal response event",
          false,
        );
      }
    } catch (error) {
      if (!terminalSeen) {
        const cancelled = ctx.signal?.aborted
          || (error instanceof DOMException && error.name === "AbortError");
        const bridgeError = error instanceof BridgeError ? error : undefined;
        fail(
          cancelled ? "cancelled" : "failed",
          cancelled ? "client_cancelled" : bridgeError?.code ?? "provider_exception",
          cancelled
            ? "Codex Router turn was cancelled"
            : bridgeError?.message ?? "Codex Router provider request failed",
          bridgeError?.retryable ?? false,
        );
      }
    }

    return result;
  }
}

export function codexRouterProviderOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexRouterProviderOptions | undefined {
  const baseUrl = env.AGENT_CHATGPT_CODEX_ROUTER_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    apiKey: env.AGENT_CHATGPT_CODEX_ROUTER_API_KEY?.trim() || undefined,
  };
}
