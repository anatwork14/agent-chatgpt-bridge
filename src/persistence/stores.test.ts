import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "./database";
import { SessionStore } from "./session-store";
import { TurnStore } from "./turn-store";
import { MessageStore } from "./message-store";

afterEach(() => {
  closeDatabase();
});

test("SessionStore CRUD operations", () => {
  initDatabase(":memory:");
  const store = new SessionStore();

  store.create({
    id: "ses_1",
    name: "demo",
    provider: "chatgpt-web",
    model: "chatgpt-web/high",
    status: "ready",
    conversationEpoch: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  let session = store.get("ses_1");
  expect(session?.model).toBe("chatgpt-web/high");
  expect(store.getByName("demo")?.id).toBe("ses_1");
  expect(store.list()).toHaveLength(1);

  store.update("ses_1", { status: "closed" });
  session = store.get("ses_1");
  expect(session?.status).toBe("closed");
});

test("TurnStore and MessageStore operations", () => {
  initDatabase(":memory:");
  const sessionStore = new SessionStore();
  const msgStore = new MessageStore();
  const turnStore = new TurnStore();

  sessionStore.create({
    id: "ses_2",
    provider: "chatgpt-web",
    model: "chatgpt-web/high",
    status: "ready",
    conversationEpoch: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  msgStore.create({
    id: "msg_1",
    sessionId: "ses_2",
    role: "user",
    contentJson: "[]",
    createdAt: new Date().toISOString(),
  });

  expect(msgStore.listBySession("ses_2")).toHaveLength(1);

  turnStore.create({
    id: "turn_1",
    requestId: "req_1",
    sessionId: "ses_2",
    status: "running",
    source: "cli",
    startedAt: new Date().toISOString(),
  });
  expect(turnStore.getActiveBySession("ses_2")?.id).toBe("turn_1");

  turnStore.update("turn_1", {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  expect(turnStore.get("turn_1")?.status).toBe("completed");
  expect(turnStore.getActiveBySession("ses_2")).toBeNull();
});
