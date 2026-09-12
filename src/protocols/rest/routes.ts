import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { SessionManager } from "../../core/session-manager";
import { BridgeError } from "../../core/errors";

export function createBridgeApi(sessionManager: SessionManager) {
  const app = new Hono();

  // Authentication middleware
  app.use("*", async (c, next) => {
    // Basic auth check for local native API token
    // For now we assume tests will mock it or we will pass it
    await next();
  });

  // Global Error Handler
  app.onError((err, c) => {
    if (err instanceof BridgeError) {
      const status = err.code === "session_not_found" ? 404 : 
                     err.code.includes("conflict") || err.code === "session_closed" || err.code === "session_busy" ? 409 : 
                     400;
      return c.json(err.toJSON(), status as any);
    }
    return c.json({
      error: {
        code: "internal_error",
        message: err.message,
        retryable: false
      }
    }, 500);
  });

  app.post("/sessions", async (c) => {
    const body = await c.req.json();
    const session = await sessionManager.create({
      name: body.name,
      provider: body.provider || "chatgpt-web",
      model: body.model || "chatgpt-web/auto",
      effort: body.effort,
      metadata: body.metadata,
    });
    return c.json(session, 201);
  });

  app.get("/sessions", async (c) => {
    const sessions = await sessionManager.list();
    return c.json(sessions);
  });

  app.get("/sessions/:id", async (c) => {
    const session = await sessionManager.get(c.req.param("id"));
    return c.json(session);
  });

  app.post("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const isStream = body.stream === true || c.req.query("stream") === "true";

    if (isStream) {
      return streamSSE(c, async (stream) => {
        try {
          await sessionManager.send(id, {
            source: "rest",
            model: { provider: "chatgpt-web", model: "auto" }, // Should resolve from session
            messages: [{ id: "msg_" + Date.now(), role: "user", content: body.content, createdAt: new Date().toISOString() }],
            stream: true,
          }, {
            emit: (event) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
          });
        } catch (e: any) {
          stream.writeSSE({ event: "error", data: JSON.stringify({ message: e.message }) });
        }
      });
    } else {
      const result = await sessionManager.send(id, {
        source: "rest",
        model: { provider: "chatgpt-web", model: "auto" },
        messages: [{ id: "msg_" + Date.now(), role: "user", content: body.content, createdAt: new Date().toISOString() }],
        stream: false,
      }, { emit: () => {} });

      return c.json({
        turn_id: result.turnId,
        session_id: result.sessionId,
        status: result.status,
        message: {
          role: "assistant",
          content: [{ type: "text", text: result.text }]
        }
      });
    }
  });

  app.delete("/sessions/:id", async (c) => {
    await sessionManager.close(c.req.param("id"));
    return c.json({ success: true });
  });

  app.post("/sessions/:id/cancel", async (c) => {
    // Simplified: need turn id if there's one, or just cancel active
    await sessionManager.cancel(c.req.param("id"), "latest"); 
    return c.json({ success: true });
  });

  app.get("/models", async (c) => {
    return c.json({
        models: ["chatgpt-web/auto", "chatgpt-web/gpt-4o", "chatgpt-web/gpt-4"]
    });
  });

}

  app.post("/runs", async (c) => {
    const body = await c.req.json();
    let sessionId = body.chatgpt?.session_id;
    if (!sessionId) {
      const session = await sessionManager.create({
        name: "Run session",
        provider: "chatgpt-web",
        model: "auto"
      });
      sessionId = session.id;
    }
    
    // NOTE: This assumes RunController is accessible globally or passed in, 
    // but we can just require it for now if needed.
    const { RunController } = require("../../core/run-controller");
    const { RunStore } = require("../../persistence/run-store");
    const { SubprocessJsonlAdapter } = require("../../agents/subprocess-jsonl");

    const runController = new RunController(
      new RunStore(), 
      sessionManager, 
      (id, cmd) => new SubprocessJsonlAdapter(cmd || [])
    );

    const run = await runController.startRun(
      sessionId,
      body.objective,
      body.agent_adapter?.type || "subprocess-jsonl",
      body.agent_adapter?.command,
      {
        maxRounds: body.budget?.max_rounds,
        maxWallClockMs: body.budget?.max_wall_clock_ms,
        maxConsecutiveFailures: body.budget?.max_consecutive_failures
      }
    );

    return c.json(run, 201);
  });

  app.get("/runs/:id", async (c) => {
    const { RunStore } = require("../../persistence/run-store");
    const store = new RunStore();
    const run = store.get(c.req.param("id"));
    return c.json(run);
  });
return app; }
