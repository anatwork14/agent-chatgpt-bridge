import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "../persistence/database";
import { SessionStore } from "../persistence/session-store";
import { MessageStore } from "../persistence/message-store";
import { TurnStore } from "../persistence/turn-store";
import { SessionManager } from "./session-manager";
import { FakeConversationProvider } from "../providers/fake/provider";

afterEach(() => {
  closeDatabase();
});

test("SessionManager isolated execution", async () => {
  initDatabase(":memory:");
  const sessionStore = new SessionStore();
  const messageStore = new MessageStore();
  const turnStore = new TurnStore();
  const provider = new FakeConversationProvider();

  const manager = new SessionManager(sessionStore, messageStore, turnStore, {
    fake: provider,
  });

  const s1 = await manager.create({ provider: "fake", model: "fake-model", name: "session_1" });
  const s2 = await manager.create({ provider: "fake", model: "fake-model", name: "session_2" });

  let events1 = 0;
  let events2 = 0;

  const req = {
    source: "internal" as const,
    model: { provider: "fake" as const, model: "fake-model" },
    messages: [{ id: "m_" + Math.random(), role: "user" as const, content: [{ type: "text" as const, text: "Hello" }], createdAt: new Date().toISOString() }],
    stream: false,
  };

  await Promise.all([
    manager.send(s1.id, req, { emit: () => events1++ }),
    manager.send(s2.id, req, { emit: () => events2++ })
  ]);

  expect(events1).toBeGreaterThan(0);
  expect(events2).toBeGreaterThan(0);

  const msgs1 = messageStore.listBySession(s1.id);
  // 1 user msg, 1 assistant msg
  expect(msgs1.length).toBe(2);
  expect(msgs1[1].role).toBe("assistant");
});

test("SessionManager serialization", async () => {
  initDatabase(":memory:");
  const sessionStore = new SessionStore();
  const messageStore = new MessageStore();
  const turnStore = new TurnStore();

  // Create a provider that takes time to complete
  let activeRuns = 0;
  const slowProvider = {
    name: "slow",
    capabilities: async () => ({ supportsImages: true, supportsTools: false, models: [] }),
    runTurn: async (req: any, _ctx: any) => {
      activeRuns++;
      expect(activeRuns).toBe(1); // Should only have 1 active at a time
      await new Promise(r => setTimeout(r, 20));
      activeRuns--;
      return { requestId: req.requestId, sessionId: req.sessionId, turnId: "t_" + Math.random(), status: "completed", text: "done" };
    }
  };

  const manager = new SessionManager(sessionStore, messageStore, turnStore, {
    slow: slowProvider as any,
  });

  const s = await manager.create({ provider: "slow", model: "slow" });

  const req = {
    source: "internal" as const,
    model: { provider: "fake" as const, model: "fake-model" },
    messages: [],
    stream: false,
  };

  await Promise.all([
    manager.send(s.id, req, { emit: () => {} }),
    manager.send(s.id, req, { emit: () => {} }),
    manager.send(s.id, req, { emit: () => {} })
  ]);
});

test("SessionManager cancel and close", async () => {
  initDatabase(":memory:");
  const sessionStore = new SessionStore();
  const manager = new SessionManager(sessionStore, new MessageStore(), new TurnStore(), {
    fake: new FakeConversationProvider(),
  });

  const s = await manager.create({ provider: "fake", model: "fake-model" });
  await manager.cancel(s.id, "turn_1"); // should not throw

  await manager.close(s.id);
  const closed = await manager.get(s.id);
  expect(closed.status).toBe("closed");

  // sending to closed session throws
  let error;
  try {
    await manager.send(s.id, {
        source: "internal",
        model: { provider: "fake", model: "fake-model" },
        messages: [],
        stream: false,
    }, { emit: () => {} });
  } catch (e: any) {
    error = e;
  }
  expect(error.code).toBe("session_closed");
});

test("SessionManager waits for provider retirement before reusing a cancelled ChatGPT session", async () => {
  initDatabase(":memory:");
  const sessionStore = new SessionStore();
  const messageStore = new MessageStore();
  const turnStore = new TurnStore();
  let starts = 0;
  const turnIds: string[] = [];
  let releaseCancelledTurn!: () => void;
  const cancelledRetirement = new Promise<void>(resolve => { releaseCancelledTurn = resolve; });
  const provider = {
    name: "chatgpt-web",
    capabilities: async () => ({ supportsImages: true, supportsTools: false, models: ["chatgpt-model"] }),
    runTurn: async (request: any, ctx: { signal?: AbortSignal }) => {
      starts += 1;
      turnIds.push(request.requestId);
      if (starts === 1) {
        return await new Promise<any>(resolve => {
          const onAbort = () => resolve({
            requestId: request.requestId,
            sessionId: request.sessionId,
            turnId: request.requestId,
            status: "cancelled" as const,
            text: "",
            error: { code: "client_cancelled", message: "cancelled", retryable: false },
          });
          if (ctx.signal?.aborted) onAbort();
          else ctx.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return {
        requestId: request.requestId,
        sessionId: request.sessionId,
        turnId: request.requestId,
        status: "completed" as const,
        text: "second turn completed",
      };
    },
    cancelTurn: async () => { await cancelledRetirement; },
  };
  const manager = new SessionManager(sessionStore, messageStore, turnStore, { "chatgpt-web": provider });
  const session = await manager.create({ provider: "chatgpt-web", model: "chatgpt-model" });
  const request = {
    source: "mcp" as const,
    model: { provider: "chatgpt-web", model: "chatgpt-model" },
    messages: [{ id: "cancelled-user", role: "user" as const, content: [{ type: "text" as const, text: "cancel me" }], createdAt: new Date().toISOString() }],
    stream: false,
  };
  const first = manager.send(session.id, request, { emit: () => undefined });
  while (starts === 0) await Bun.sleep(1);
  const cancellation = manager.cancel(session.id);
  let cancellationSettled = false;
  void cancellation.finally(() => { cancellationSettled = true; });
  await Bun.sleep(10);
  expect(cancellationSettled).toBe(false);
  releaseCancelledTurn();
  await cancellation;
  await first;

  const second = await manager.send(session.id, {
    ...request,
    messages: [{ ...request.messages[0], id: "second-user", content: [{ type: "text" as const, text: "continue" }] }],
  }, { emit: () => undefined });
  expect(second.status).toBe("completed");
  expect((await manager.get(session.id)).status).toBe("ready");
  expect(turnStore.get(turnIds[0]!)?.status).toBe("cancelled");
  expect(turnStore.get(turnIds[1]!)?.status).toBe("completed");
  expect(messageStore.listBySession(session.id).map(message => message.id)).toEqual(["second-user", `msg_${second.turnId}`]);
  expect((await manager.get(session.id)).provider).toBe("chatgpt-web");
  expect((await manager.get(session.id)).model).toBe("chatgpt-model");
});
