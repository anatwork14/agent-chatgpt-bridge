import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { generateId } from "../../core/ids";
import { SessionManager } from "../../core/session-manager";
import type { RunController } from "../../core/run-controller";
import { BridgeError } from "../../core/errors";
import type { BridgeContentPart, CollaborationRun, ExternalAgentAdapterConfig } from "../../core/domain";
import { IdempotencyStore } from "../../persistence/idempotency-store";
import { executeIdempotent, validateIdempotencyKey } from "./idempotency";

export interface BridgeApiOptions {
  /** Optional local bearer token. Production composition should provide one by default. */
  apiToken?: string;
  defaultProvider?: string;
  defaultModel?: string;
  listModels?: () => Promise<string[]>;
  runController?: RunController;
  listRuns?: () => CollaborationRun[] | Promise<CollaborationRun[]>;
  idempotencyStore?: IdempotencyStore;
  requestShutdown?: () => void;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", `${field} must be an object`, false);
  }
  return value as Record<string, unknown>;
}

function contentParts(value: unknown): BridgeContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeError("invalid_request", "content must be a non-empty array", false);
  }
  return value as BridgeContentPart[];
}

function bridgeStatus(error: BridgeError): number {
  switch (error.code) {
    case "session_not_found":
    case "run_not_found":
      return 404;
    case "authentication_required":
      return 401;
    case "session_closed":
    case "session_busy":
    case "session_conflict":
    case "idempotency_conflict":
    case "idempotency_in_progress":
      return 409;
    case "provider_rate_limited":
    case "local_queue_full":
      return 429;
    case "provider_unavailable":
    case "browser_not_ready":
      return 503;
    case "idempotency_corrupt":
    case "session_history_corrupt":
      return 500;
    default:
      return 400;
  }
}

export function createBridgeApi(sessionManager: SessionManager, options: BridgeApiOptions = {}) {
  const app = new Hono().basePath("/bridge/v1");
  const idempotencyStore = options.idempotencyStore ?? new IdempotencyStore();

  app.use("*", async (c, next) => {
    if (options.apiToken && !tokenMatches(c.req.header("authorization"), options.apiToken)) {
      return c.json(new BridgeError(
        "authentication_required",
        "A valid local bridge bearer token is required",
        false,
      ).toJSON(), 401);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof BridgeError) {
      return c.json(error.toJSON(), bridgeStatus(error) as any);
    }
    return c.json({
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : "Internal bridge error",
        retryable: false,
      },
    }, 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok", service: "agent-chatgpt-bridge" }));

  app.post("/shutdown", (c) => {
    if (!options.requestShutdown) {
      throw new BridgeError("provider_unavailable", "Bridge process shutdown control is not configured", false);
    }
    options.requestShutdown();
    return c.json({ success: true, status: "shutting_down" });
  });

  app.post("/sessions", async (c) => {
    const body = requireObject(await c.req.json(), "request body");
    const { value: session, replayed } = await executeIdempotent(
      idempotencyStore,
      "POST:/sessions",
      c.req.header("idempotency-key"),
      body,
      async () => {
        const provider = typeof body.provider === "string"
          ? body.provider
          : options.defaultProvider ?? "chatgpt-web";
        const model = typeof body.model === "string" ? body.model : options.defaultModel;
        if (!model) {
          throw new BridgeError(
            "invalid_request",
            "model is required unless the daemon has an explicit default model configured",
            false,
          );
        }
        return await sessionManager.create({
          name: typeof body.name === "string" ? body.name : undefined,
          provider,
          model,
          effort: typeof body.effort === "string" ? body.effort : undefined,
          metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : undefined,
        });
      },
    );
    if (replayed) c.header("idempotency-replayed", "true");
    return c.json(session, 201);
  });

  app.get("/sessions", async (c) => c.json(await sessionManager.list()));

  app.get("/sessions/:id", async (c) => c.json(await sessionManager.get(c.req.param("id"))));

  app.get("/sessions/:id/messages", async (c) => {
    return c.json(await sessionManager.transcript(c.req.param("id")));
  });

  app.post("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = requireObject(await c.req.json(), "request body");
    const content = contentParts(body.content);
    const isStream = body.stream === true || c.req.query("stream") === "true";
    const idempotencyKey = validateIdempotencyKey(c.req.header("idempotency-key"));
    if (isStream && idempotencyKey) {
      throw new BridgeError(
        "invalid_request",
        "Idempotency-Key is not supported for SSE streaming turns; use non-streaming mode for replayable retries",
        false,
      );
    }
    const session = await sessionManager.get(id);

    const makeRequest = () => ({
      source: "rest" as const,
      model: { provider: session.provider, model: session.model, effort: session.effort },
      messages: [{
        id: generateId("msg"),
        role: "user" as const,
        content,
        createdAt: new Date().toISOString(),
      }],
      stream: isStream,
    });

    if (isStream) {
      const request = makeRequest();
      return streamSSE(c, async (stream) => {
        try {
          await sessionManager.send(id, request, {
            signal: c.req.raw.signal,
            emit: event => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
          });
        } catch (error) {
          const payload = error instanceof BridgeError
            ? error.toJSON()
            : { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error), retryable: false } };
          await stream.writeSSE({ event: "turn.failed", data: JSON.stringify(payload) });
        }
      });
    }

    const { value: response, replayed } = await executeIdempotent(
      idempotencyStore,
      `POST:/sessions/${session.id}/messages`,
      idempotencyKey,
      body,
      async () => {
        const result = await sessionManager.send(id, makeRequest(), {
          signal: c.req.raw.signal,
          emit: () => undefined,
        });
        return {
          turn_id: result.turnId,
          session_id: result.sessionId,
          status: result.status,
          message: {
            role: "assistant",
            content: [{ type: "text", text: result.text }],
          },
          error: result.error,
          usage: result.usage,
        };
      },
    );
    if (replayed) c.header("idempotency-replayed", "true");
    return c.json(response);
  });

  app.delete("/sessions/:id", async (c) => {
    await sessionManager.close(c.req.param("id"));
    return c.json({ success: true });
  });

  app.post("/sessions/:id/cancel", async (c) => {
    const cancelled = await sessionManager.cancel(c.req.param("id"), "latest");
    return c.json({ success: true, cancelled });
  });

  app.get("/models", async (c) => {
    const models = options.listModels ? await options.listModels() : [];
    return c.json({ models });
  });

  app.post("/runs", async (c) => {
    if (!options.runController) {
      throw new BridgeError("provider_unavailable", "Autonomous run controller is not configured", false);
    }
    const body = requireObject(await c.req.json(), "request body");
    const { value: run, replayed } = await executeIdempotent(
      idempotencyStore,
      "POST:/runs",
      c.req.header("idempotency-key"),
      body,
      async () => {
        if (typeof body.objective !== "string" || !body.objective.trim()) {
          throw new BridgeError("invalid_request", "objective is required", false);
        }
        const adapter = requireObject(body.agent_adapter, "agent_adapter");
        if (typeof adapter.type !== "string") {
          throw new BridgeError("invalid_request", "agent_adapter.type is required", false);
        }
        const command = Array.isArray(adapter.command) && adapter.command.every(value => typeof value === "string")
          ? adapter.command as string[]
          : undefined;
        if (adapter.command !== undefined && !command) {
          throw new BridgeError("invalid_request", "agent_adapter.command must be an array of strings", false);
        }
        const permissionMode = adapter.permission_mode;
        if (permissionMode !== undefined
          && permissionMode !== "deny"
          && permissionMode !== "allow_readonly"
          && permissionMode !== "delegate") {
          throw new BridgeError(
            "invalid_request",
            "agent_adapter.permission_mode must be deny, allow_readonly, or delegate",
            false,
          );
        }
        if (permissionMode === "delegate") {
          throw new BridgeError(
            "invalid_request",
            "agent_adapter.permission_mode=delegate is only available to embedded callers with a resolver",
            false,
          );
        }
        if (permissionMode !== undefined && !adapter.type.startsWith("acp")) {
          throw new BridgeError(
            "invalid_request",
            "agent_adapter.permission_mode is only supported by ACP agents",
            false,
          );
        }
        const agentAdapterConfig: ExternalAgentAdapterConfig = {
          profile: typeof adapter.profile === "string" ? adapter.profile : undefined,
          permissionMode: typeof permissionMode === "string" ? permissionMode : undefined,
        };

        const chatgpt = body.chatgpt && typeof body.chatgpt === "object" && !Array.isArray(body.chatgpt)
          ? body.chatgpt as Record<string, unknown>
          : {};
        let sessionId = typeof chatgpt.session_id === "string" ? chatgpt.session_id : undefined;
        if (!sessionId) {
          const model = typeof chatgpt.model === "string" ? chatgpt.model : options.defaultModel;
          if (!model) {
            throw new BridgeError(
              "invalid_request",
              "chatgpt.session_id or an explicit/default ChatGPT model is required",
              false,
            );
          }
          const session = await sessionManager.create({
            provider: options.defaultProvider ?? "chatgpt-web",
            model,
            effort: typeof chatgpt.effort === "string" ? chatgpt.effort : undefined,
          });
          sessionId = session.id;
        }

        const budget = body.budget && typeof body.budget === "object" && !Array.isArray(body.budget)
          ? body.budget as Record<string, unknown>
          : {};
        return await options.runController!.startRun(
          sessionId,
          body.objective as string,
          adapter.type,
          command,
          {
            maxRounds: typeof budget.max_rounds === "number" ? budget.max_rounds : undefined,
            maxWallClockMs: typeof budget.max_wall_clock_ms === "number" ? budget.max_wall_clock_ms : undefined,
            maxConsecutiveFailures: typeof budget.max_consecutive_failures === "number"
              ? budget.max_consecutive_failures
              : undefined,
          },
          agentAdapterConfig,
        );
      },
    );
    if (replayed) c.header("idempotency-replayed", "true");
    return c.json(run, 201);
  });

  app.get("/runs", async (c) => {
    if (!options.listRuns) {
      throw new BridgeError("provider_unavailable", "Run listing is not configured", false);
    }
    return c.json(await options.listRuns());
  });

  app.get("/runs/:id", async (c) => {
    if (!options.runController) {
      throw new BridgeError("provider_unavailable", "Autonomous run controller is not configured", false);
    }
    const run = options.runController.getRun(c.req.param("id"));
    if (!run) throw new BridgeError("run_not_found", `Run ${c.req.param("id")} not found`, false);
    return c.json(run);
  });

  app.post("/runs/:id/cancel", async (c) => {
    if (!options.runController) {
      throw new BridgeError("provider_unavailable", "Autonomous run controller is not configured", false);
    }
    const cancelled = await options.runController.cancelRun(c.req.param("id"));
    if (!cancelled && !options.runController.getRun(c.req.param("id"))) {
      throw new BridgeError("run_not_found", `Run ${c.req.param("id")} not found`, false);
    }
    return c.json({ success: true, cancelled });
  });

  return app;
}
