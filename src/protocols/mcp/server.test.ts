import { expect, test, afterEach } from "bun:test";
import { AgentChatGptMcpServer } from "./server";
import { SessionManager } from "../../core/session-manager";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { initDatabase, closeDatabase } from "../../persistence/database";
import { SessionStore } from "../../persistence/session-store";
import { MessageStore } from "../../persistence/message-store";
import { TurnStore } from "../../persistence/turn-store";

afterEach(() => {
  closeDatabase();
});

function isErrorResult(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { isError?: unknown }).isError === true;
}

test("MCP server tool handling", async () => {
  initDatabase(":memory:");
  const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });
  const server = new AgentChatGptMcpServer(sm, {
    defaultProvider: "chatgpt-web",
    defaultModel: "fake-model",
    listModels: async () => ["fake-model"],
  });

  const createRes = await server.handleToolCall("chatgpt_create_session", { name: "test-mcp" });
  expect(isErrorResult(createRes)).toBe(false);
  const session = JSON.parse(createRes.content[0].text);
  expect(session.name).toBe("test-mcp");
  expect(session.model).toBe("fake-model");

  const askRes = await server.handleToolCall("chatgpt_ask", { message: "Hello", session_id: session.id });
  expect(isErrorResult(askRes)).toBe(false);
  const askPayload = JSON.parse(askRes.content[0].text);
  expect(askPayload.session_id).toBe(session.id);
  expect(askPayload.text).toBe("This is a fake response.");

  const listModelsRes = await server.handleToolCall("chatgpt_list_models", {});
  expect(isErrorResult(listModelsRes)).toBe(false);
  expect(JSON.parse(listModelsRes.content[0].text).models).toEqual(["fake-model"]);

  const cancelRes = await server.handleToolCall("chatgpt_cancel", { session_id: session.id });
  expect(isErrorResult(cancelRes)).toBe(false);
  expect(JSON.parse(cancelRes.content[0].text)).toEqual({ cancelled: false });
});
