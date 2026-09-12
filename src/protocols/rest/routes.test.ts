import { expect, test, afterEach } from "bun:test";
import { createBridgeApi } from "./routes";
import { SessionManager } from "../../core/session-manager";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { initDatabase, closeDatabase } from "../../persistence/database";
import { SessionStore } from "../../persistence/session-store";
import { MessageStore } from "../../persistence/message-store";
import { TurnStore } from "../../persistence/turn-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(os.tmpdir(), `test-bridge-rest-${Date.now()}.db`);

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + "-wal")) fs.unlinkSync(testDbPath + "-wal");
  if (fs.existsSync(testDbPath + "-shm")) fs.unlinkSync(testDbPath + "-shm");
});

test("REST API session lifecycle", async () => {
  initDatabase(testDbPath);
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });
  const app = createBridgeApi(sm);

  const res1 = await app.request("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-session", provider: "chatgpt-web", model: "auto" })
  });
  expect(res1.status).toBe(201);
  const session = await res1.json();
  expect(session.name).toBe("test-session");

  const res2 = await app.request(`/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello" }],
      stream: false
    })
  });
  expect(res2.status).toBe(200);
  const turn = await res2.json();
  expect(turn.message.content[0].text).toBe("This is a fake response.");

  const res3 = await app.request(`/sessions`, { method: "GET" });
  const sessions = await res3.json();
  expect(sessions.length).toBe(1);

  const res4 = await app.request(`/sessions/${session.id}`, { method: "DELETE" });
  expect(res4.status).toBe(200);
});

test("REST API SSE", async () => {
  initDatabase(testDbPath);
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });
  const app = createBridgeApi(sm);

  const res1 = await app.request("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-sse", provider: "chatgpt-web", model: "auto" })
  });
  const session = await res1.json();

  const res2 = await app.request(`/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello" }],
      stream: true
    })
  });
  
  const text = await res2.text();
  expect(text).toContain("event: turn.started");
  expect(text).toContain("event: text.delta");
  expect(text).toContain("event: turn.completed");
});
