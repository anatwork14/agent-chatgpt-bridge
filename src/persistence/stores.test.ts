import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase } from "./database";
import { SessionStore } from "./session-store";
import { TurnStore } from "./turn-store";
import { MessageStore } from "./message-store";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDbPath = path.join(os.tmpdir(), `test-bridge-stores-${Date.now()}.db`);

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath); if (fs.existsSync(testDbPath + "-wal")) fs.unlinkSync(testDbPath + "-wal"); if (fs.existsSync(testDbPath + "-shm")) fs.unlinkSync(testDbPath + "-shm");
  }
});

test("SessionStore CRUD operations", () => {
  initDatabase(testDbPath);
  const store = new SessionStore();
  
  store.create({
    id: "ses_1",
    provider: "chatgpt-web",
    model: "gpt-4",
    status: "active",
    conversationEpoch: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  
  let s = store.get("ses_1");
  expect(s?.model).toBe("gpt-4");
  
  store.update("ses_1", { status: "closed" });
  s = store.get("ses_1");
  expect(s?.status).toBe("closed");
});

test("TurnStore and MessageStore operations", () => {
  initDatabase(testDbPath);
  const sessionStore = new SessionStore();
  const msgStore = new MessageStore();
  const turnStore = new TurnStore();

  sessionStore.create({
    id: "ses_2",
    provider: "chatgpt-web",
    model: "gpt-4",
    status: "active",
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
  
  expect(msgStore.listBySession("ses_2").length).toBe(1);

  turnStore.create({
    id: "turn_1",
    requestId: "req_1",
    sessionId: "ses_2",
    status: "completed",
    source: "cli",
  });
  
  expect(turnStore.get("turn_1")?.status).toBe("completed");
});
