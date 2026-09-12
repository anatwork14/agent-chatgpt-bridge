import { expect, test, afterEach } from "bun:test";
import { AgentChatGptMcpServer } from "./server";
import { SessionManager } from "../../core/session-manager";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { initDatabase, closeDatabase } from "../../persistence/database";
import { SessionStore } from "../../persistence/session-store";
import { MessageStore } from "../../persistence/message-store";
import { TurnStore } from "../../persistence/turn-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(os.tmpdir(), `test-bridge-mcp-${Date.now()}.db`);

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + "-wal")) fs.unlinkSync(testDbPath + "-wal");
  if (fs.existsSync(testDbPath + "-shm")) fs.unlinkSync(testDbPath + "-shm");
});

test("MCP server tool handling", async () => {
  initDatabase(testDbPath);
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });
  const server = new AgentChatGptMcpServer(sm);

  const createRes = await server.handleToolCall("chatgpt_create_session", { name: "test-mcp" });
  expect(createRes.isError).toBeFalsy();
  const sessionStr = createRes.content[0].text;
  const session = JSON.parse(sessionStr);
  expect(session.name).toBe("test-mcp");

  const askRes = await server.handleToolCall("chatgpt_ask", { message: "Hello", session_id: session.id });
  expect(askRes.isError).toBeFalsy();
  expect(askRes.content[0].text).toBe("This is a fake response.");

  const cancelRes = await server.handleToolCall("chatgpt_cancel", { session_id: session.id });
  expect(cancelRes.content[0].text).toBe("Cancelled");
});
