import { expect, test, afterEach } from "bun:test";
import { createBridgeApi } from "./routes";
import { SessionManager } from "../../core/session-manager";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { initDatabase, closeDatabase } from "../../persistence/database";
import { SessionStore } from "../../persistence/session-store";
import { MessageStore } from "../../persistence/message-store";
import { TurnStore } from "../../persistence/turn-store";

afterEach(() => {
  closeDatabase();
});

function fixture(token?: string) {
  initDatabase(":memory:");
  const provider = new FakeConversationProvider();
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    fake: provider,
  });
  return {
    sm,
    app: createBridgeApi(sm, {
      apiToken: token,
      defaultProvider: "fake",
      defaultModel: "fake-model",
      listModels: async () => (await provider.capabilities()).models,
    }),
  };
}

test("REST API session lifecycle", async () => {
  const { app } = fixture();

  const create = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-session" }),
  });
  expect(create.status).toBe(201);
  const session = await create.json() as any;
  expect(session.name).toBe("test-session");
  expect(session.model).toBe("fake-model");

  const send = await app.request(`/bridge/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello" }],
      stream: false,
    }),
  });
  expect(send.status).toBe(200);
  const turn = await send.json() as any;
  expect(turn.status).toBe("completed");
  expect(turn.message.content[0].text).toBe("This is a fake response.");

  const transcript = await app.request(`/bridge/v1/sessions/${session.id}/messages`);
  expect(transcript.status).toBe(200);
  expect((await transcript.json() as any[]).map(message => message.role)).toEqual(["user", "assistant"]);

  const list = await app.request("/bridge/v1/sessions");
  expect((await list.json() as any[])).toHaveLength(1);

  const models = await app.request("/bridge/v1/models");
  expect(await models.json()).toEqual({ models: ["fake-model"] });

  const close = await app.request(`/bridge/v1/sessions/${session.id}`, { method: "DELETE" });
  expect(close.status).toBe(200);
});

test("REST API SSE forwards bridge events", async () => {
  const { app } = fixture();
  const create = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-sse" }),
  });
  const session = await create.json() as any;

  const response = await app.request(`/bridge/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello" }],
      stream: true,
    }),
  });

  const text = await response.text();
  expect(text).toContain("event: turn.started");
  expect(text).toContain("event: text.delta");
  expect(text).toContain("event: turn.completed");
});

test("REST API enforces configured local bearer token", async () => {
  const { app } = fixture("test-secret");

  const denied = await app.request("/bridge/v1/sessions");
  expect(denied.status).toBe(401);

  const allowed = await app.request("/bridge/v1/sessions", {
    headers: { Authorization: "Bearer test-secret" },
  });
  expect(allowed.status).toBe(200);
});

test("REST API replays session creation for the same idempotency key", async () => {
  const { app } = fixture();
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "create-session-1",
    },
    body: JSON.stringify({ name: "idempotent-session" }),
  };

  const first = await app.request("/bridge/v1/sessions", init);
  const firstSession = await first.json() as any;
  const second = await app.request("/bridge/v1/sessions", init);
  const secondSession = await second.json() as any;

  expect(second.headers.get("idempotency-replayed")).toBe("true");
  expect(secondSession.id).toBe(firstSession.id);
  const sessions = await app.request("/bridge/v1/sessions");
  expect((await sessions.json() as any[])).toHaveLength(1);
});

test("REST API rejects idempotency key reuse with a different body", async () => {
  const { app } = fixture();
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": "create-session-conflict",
  };
  const first = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "first" }),
  });
  expect(first.status).toBe(201);

  const conflict = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "second" }),
  });
  expect(conflict.status).toBe(409);
  expect((await conflict.json() as any).error.code).toBe("idempotency_conflict");
});

test("REST API replays a non-streaming ChatGPT turn without duplicating transcript", async () => {
  const { app } = fixture();
  const create = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "turn-idempotency" }),
  });
  const session = await create.json() as any;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "turn-1",
    },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello once" }],
      stream: false,
    }),
  };

  const first = await app.request(`/bridge/v1/sessions/${session.id}/messages`, init);
  const firstTurn = await first.json() as any;
  const second = await app.request(`/bridge/v1/sessions/${session.id}/messages`, init);
  const secondTurn = await second.json() as any;

  expect(second.headers.get("idempotency-replayed")).toBe("true");
  expect(secondTurn.turn_id).toBe(firstTurn.turn_id);
  const transcript = await app.request(`/bridge/v1/sessions/${session.id}/messages`);
  expect(await transcript.json()).toHaveLength(2);
});

test("REST API rejects idempotency keys on SSE turns", async () => {
  const { app } = fixture();
  const create = await app.request("/bridge/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "sse-no-replay" }),
  });
  const session = await create.json() as any;

  const response = await app.request(`/bridge/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "sse-turn",
    },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello" }],
      stream: true,
    }),
  });
  expect(response.status).toBe(400);
});
