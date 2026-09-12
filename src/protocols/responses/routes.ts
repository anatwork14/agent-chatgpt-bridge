import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { BridgeContentPart, BridgeMessage, BridgeOutputContract } from "../../core/domain";
import { BridgeError } from "../../core/errors";
import type { BridgeEvent } from "../../core/events";
import { generateId, generateTurnId } from "../../core/ids";
import { SessionManager } from "../../core/session-manager";
import { TurnStore } from "../../persistence/turn-store";

export interface ResponsesApiOptions {
  apiToken?: string;
  defaultProvider?: string;
  defaultModel?: string;
  listModels?: () => Promise<string[]>;
  turnStore: TurnStore;
}

interface ParsedResponsesRequest {
  model: string;
  previousResponseId?: string;
  stream: boolean;
  messages: BridgeMessage[];
  output?: BridgeOutputContract;
  effort?: string;
  metadata?: Record<string, unknown>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function bridgeStatus(error: BridgeError): number {
  switch (error.code) {
    case "session_not_found":
      return 404;
    case "authentication_required":
      return 401;
    case "session_closed":
    case "session_busy":
    case "session_conflict":
      return 409;
    case "provider_rate_limited":
    case "local_queue_full":
      return 429;
    case "provider_unavailable":
    case "browser_not_ready":
    case "server_draining":
      return 503;
    case "session_history_corrupt":
      return 500;
    default:
      return 400;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof BridgeError) {
    return Response.json({
      error: {
        message: error.message,
        type: "invalid_request_error",
        code: error.code,
        param: null,
      },
    }, { status: bridgeStatus(error) });
  }
  return Response.json({
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: "server_error",
      code: "internal_error",
      param: null,
    },
  }, { status: 500 });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", `${field} must be an object`, false);
  }
  return value as Record<string, unknown>;
}

function textPart(value: Record<string, unknown>): BridgeContentPart | undefined {
  if ((value.type === "input_text" || value.type === "text") && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "input_image") {
    const imageUrl = typeof value.image_url === "string" ? value.image_url : undefined;
    if (!imageUrl) {
      throw new BridgeError("invalid_request", "input_image requires image_url", false);
    }
    if (!imageUrl.startsWith("data:")) {
      throw new BridgeError(
        "invalid_request",
        "Generic Responses ingress currently accepts input_image only as a data URL",
        false,
      );
    }
    const detail = value.detail;
    if (detail !== undefined && detail !== "low" && detail !== "high" && detail !== "auto") {
      throw new BridgeError("invalid_request", "input_image.detail must be low, high, or auto", false);
    }
    return {
      type: "image",
      source: { type: "data_url", dataUrl: imageUrl },
      detail: detail as "low" | "high" | "auto" | undefined,
    };
  }
  return undefined;
}

function messageContent(value: unknown): BridgeContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeError("invalid_request", "message content must be a string or non-empty array", false);
  }
  const parts = value.map((part, index) => {
    const parsed = textPart(object(part, `message content[${index}]`));
    if (!parsed) {
      throw new BridgeError(
        "invalid_request",
        `Unsupported Responses content part at index ${index}`,
        false,
      );
    }
    return parsed;
  });
  return parts;
}

function parseRole(value: unknown): BridgeMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system") return value;
  if (value === "developer") return "system";
  throw new BridgeError("invalid_request", `Unsupported Responses message role: ${String(value)}`, false);
}

function parseInput(input: unknown): BridgeMessage[] {
  const now = () => new Date().toISOString();
  if (typeof input === "string") {
    return [{
      id: generateId("msg"),
      role: "user",
      content: [{ type: "text", text: input }],
      createdAt: now(),
    }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new BridgeError("invalid_request", "Responses input must be a string or non-empty array", false);
  }

  return input.map((item, index) => {
    if (typeof item === "string") {
      return {
        id: generateId("msg"),
        role: "user" as const,
        content: [{ type: "text" as const, text: item }],
        createdAt: now(),
      };
    }
    const raw = object(item, `input[${index}]`);
    if (raw.type === "input_text" && typeof raw.text === "string") {
      return {
        id: generateId("msg"),
        role: "user" as const,
        content: [{ type: "text" as const, text: raw.text }],
        createdAt: now(),
      };
    }
    if (raw.type !== undefined && raw.type !== "message") {
      throw new BridgeError(
        "invalid_request",
        `Unsupported Responses input item type: ${String(raw.type)}`,
        false,
      );
    }
    return {
      id: typeof raw.id === "string" ? raw.id : generateId("msg"),
      role: parseRole(raw.role),
      content: messageContent(raw.content),
      createdAt: now(),
    };
  });
}

function outputContract(value: unknown): BridgeOutputContract | undefined {
  if (value === undefined) return undefined;
  const text = object(value, "text");
  if (text.format === undefined) return undefined;
  const format = object(text.format, "text.format");
  if (format.type === "text") return { type: "text" };
  if (format.type !== "json_schema") {
    throw new BridgeError(
      "invalid_request",
      `Unsupported text.format.type: ${String(format.type)}`,
      false,
    );
  }
  const schema = object(format.schema, "text.format.schema");
  return { type: "json_schema", schema };
}

function parseRequest(value: unknown, defaultModel?: string): ParsedResponsesRequest {
  const body = object(value, "request body");
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new BridgeError(
      "invalid_request",
      "Generic Responses tool calling is not enabled; use the bridge MCP or REST tool surfaces instead",
      false,
    );
  }
  if (body.background === true) {
    throw new BridgeError("invalid_request", "background Responses are not supported by the local bridge", false);
  }
  if (body.conversation !== undefined) {
    throw new BridgeError(
      "invalid_request",
      "Responses conversation objects are not supported; use previous_response_id for continuity",
      false,
    );
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model : defaultModel;
  if (!model) throw new BridgeError("invalid_request", "Responses request requires model", false);
  const previousResponseId = body.previous_response_id;
  if (previousResponseId !== undefined && typeof previousResponseId !== "string") {
    throw new BridgeError("invalid_request", "previous_response_id must be a string", false);
  }
  const reasoning = body.reasoning === undefined ? undefined : object(body.reasoning, "reasoning");
  const effort = reasoning?.effort;
  if (effort !== undefined && typeof effort !== "string") {
    throw new BridgeError("invalid_request", "reasoning.effort must be a string", false);
  }

  const messages: BridgeMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({
      id: generateId("msg"),
      role: "system",
      content: [{ type: "text", text: body.instructions }],
      createdAt: new Date().toISOString(),
      // Responses API instructions are turn-scoped and intentionally do not carry through
      // previous_response_id. The provider receives them, but SessionManager does not persist them.
      metadata: { transient: true, source: "responses.instructions" },
    });
  }
  messages.push(...parseInput(body.input));

  return {
    model,
    previousResponseId,
    stream: body.stream === true,
    messages,
    output: outputContract(body.text),
    effort: effort as string | undefined,
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : undefined,
  };
}

function turnIdFromResponseId(responseId: string): string {
  if (!responseId.startsWith("resp_turn_")) {
    throw new BridgeError("invalid_request", `Invalid previous_response_id: ${responseId}`, false);
  }
  return responseId.slice("resp_".length);
}

function responseId(turnId: string): string {
  return `resp_${turnId}`;
}

function usage(result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined) {
  return {
    input_tokens: result?.inputTokens ?? 0,
    output_tokens: result?.outputTokens ?? 0,
    total_tokens: result?.totalTokens ?? ((result?.inputTokens ?? 0) + (result?.outputTokens ?? 0)),
  };
}

function responseObject(options: {
  id: string;
  createdAt: number;
  model: string;
  previousResponseId?: string;
  status: "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: { code: string; message: string; retryable: boolean };
  metadata?: Record<string, unknown>;
}) {
  const messageId = `msg_${options.id.slice("resp_".length)}`;
  const output = options.status === "in_progress" ? [] : [{
    type: "message",
    id: messageId,
    status: options.status === "completed" ? "completed" : "incomplete",
    role: "assistant",
    content: [{
      type: "output_text",
      text: options.text ?? "",
      annotations: [],
    }],
  }];
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: options.status,
    model: options.model,
    previous_response_id: options.previousResponseId ?? null,
    output,
    error: options.error ? {
      code: options.error.code,
      message: options.error.message,
    } : null,
    usage: options.status === "in_progress" ? null : usage(options.usage),
    metadata: options.metadata ?? {},
  };
}

function sseFrame(event: string | undefined, data: unknown): Uint8Array {
  const prefix = event ? `event: ${event}\n` : "";
  return new TextEncoder().encode(`${prefix}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function createResponsesApi(sessionManager: SessionManager, options: ResponsesApiOptions) {
  const app = new Hono().basePath("/v1");

  app.use("*", async (c, next) => {
    if (options.apiToken && !tokenMatches(c.req.header("authorization"), options.apiToken)) {
      return errorResponse(new BridgeError(
        "authentication_required",
        "A valid local bridge bearer token is required",
        false,
      ));
    }
    await next();
  });

  app.get("/models", async (c) => {
    try {
      const models = options.listModels ? await options.listModels() : [];
      return c.json({
        object: "list",
        data: models.map(id => ({
          id,
          object: "model",
          created: 0,
          owned_by: "agent-chatgpt-bridge",
        })),
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.post("/responses", async (c) => {
    let parsed: ParsedResponsesRequest;
    try {
      parsed = parseRequest(await c.req.json(), options.defaultModel);
    } catch (error) {
      return errorResponse(error);
    }

    try {
      let session;
      if (parsed.previousResponseId) {
        const priorTurn = options.turnStore.get(turnIdFromResponseId(parsed.previousResponseId));
        if (!priorTurn || priorTurn.source !== "responses") {
          throw new BridgeError(
            "invalid_request",
            `previous_response_id was not found: ${parsed.previousResponseId}`,
            false,
          );
        }
        session = await sessionManager.get(priorTurn.sessionId);
        if (session.model !== parsed.model) {
          throw new BridgeError(
            "invalid_request",
            `Responses continuation model ${parsed.model} does not match session model ${session.model}`,
            false,
          );
        }
        if (parsed.effort !== undefined && parsed.effort !== session.effort) {
          throw new BridgeError(
            "invalid_request",
            "reasoning.effort cannot change within a previous_response_id continuation",
            false,
          );
        }
      } else {
        session = await sessionManager.create({
          provider: options.defaultProvider ?? "chatgpt-web",
          model: parsed.model,
          effort: parsed.effort,
          metadata: {
            responsesApi: true,
            ...(parsed.metadata ? { responsesMetadata: parsed.metadata } : {}),
          },
        });
      }

      const turnId = generateTurnId();
      const id = responseId(turnId);
      const createdAt = Math.floor(Date.now() / 1000);
      const request = {
        requestId: turnId,
        source: "responses" as const,
        model: { provider: session.provider, model: session.model, effort: session.effort },
        messages: parsed.messages,
        output: parsed.output,
        stream: parsed.stream,
        metadata: parsed.metadata,
      };

      if (!parsed.stream) {
        const result = await sessionManager.send(session.id, request, {
          signal: c.req.raw.signal,
          emit: () => undefined,
        });
        const status = result.status === "cancelled" ? "cancelled" : result.status;
        return c.json(responseObject({
          id,
          createdAt,
          model: session.model,
          previousResponseId: parsed.previousResponseId,
          status,
          text: result.text,
          usage: result.usage,
          error: result.error,
          metadata: parsed.metadata,
        }));
      }

      const requestAbort = new AbortController();
      const onRequestAbort = () => requestAbort.abort(c.req.raw.signal.reason);
      c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true });
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let sequence = 0;
          let itemStarted = false;
          let text = "";
          const messageId = `msg_${turnId}`;
          const emit = (event: string, payload: Record<string, unknown>) => {
            if (cancelled) return;
            controller.enqueue(sseFrame(event, { type: event, sequence_number: sequence++, ...payload }));
          };
          const ensureItem = () => {
            if (itemStarted) return;
            itemStarted = true;
            emit("response.output_item.added", {
              output_index: 0,
              item: { type: "message", id: messageId, status: "in_progress", role: "assistant", content: [] },
            });
            emit("response.content_part.added", {
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          };

          emit("response.created", {
            response: responseObject({
              id,
              createdAt,
              model: session.model,
              previousResponseId: parsed.previousResponseId,
              status: "in_progress",
              metadata: parsed.metadata,
            }),
          });

          void sessionManager.send(session.id, request, {
            signal: requestAbort.signal,
            emit(event: BridgeEvent) {
              if (event.type !== "text.delta") return;
              ensureItem();
              text += event.delta;
              emit("response.output_text.delta", {
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: event.delta,
                logprobs: [],
              });
            },
          }).then(result => {
            if (cancelled) return;
            ensureItem();
            const finalText = result.text || text;
            emit("response.output_text.done", {
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              text: finalText,
              logprobs: [],
            });
            emit("response.content_part.done", {
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: finalText, annotations: [] },
            });
            emit("response.output_item.done", {
              output_index: 0,
              item: {
                type: "message",
                id: messageId,
                status: result.status === "completed" ? "completed" : "incomplete",
                role: "assistant",
                content: [{ type: "output_text", text: finalText, annotations: [] }],
              },
            });
            const terminalEvent = result.status === "completed"
              ? "response.completed"
              : result.status === "incomplete"
                ? "response.incomplete"
                : "response.failed";
            emit(terminalEvent, {
              response: responseObject({
                id,
                createdAt,
                model: session.model,
                previousResponseId: parsed.previousResponseId,
                status: result.status === "cancelled" ? "cancelled" : result.status,
                text: finalText,
                usage: result.usage,
                error: result.error,
                metadata: parsed.metadata,
              }),
            });
            controller.enqueue(sseFrame(undefined, "[DONE]"));
            controller.close();
          }).catch(error => {
            if (cancelled) return;
            emit("error", {
              code: error instanceof BridgeError ? error.code : "internal_error",
              message: error instanceof Error ? error.message : String(error),
              param: null,
            });
            controller.enqueue(sseFrame(undefined, "[DONE]"));
            controller.close();
          }).finally(() => {
            c.req.raw.signal.removeEventListener("abort", onRequestAbort);
          });
        },
        cancel(reason) {
          cancelled = true;
          requestAbort.abort(reason);
          c.req.raw.signal.removeEventListener("abort", onRequestAbort);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  return app;
}
