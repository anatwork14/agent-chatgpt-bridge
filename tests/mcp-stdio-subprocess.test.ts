import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const childSource = `
  import { AgentChatGptMcpServer } from ${JSON.stringify(new URL("../src/protocols/mcp/server.ts", import.meta.url).href)};
  import { SessionManager } from ${JSON.stringify(new URL("../src/core/session-manager.ts", import.meta.url).href)};
  import { FakeConversationProvider } from ${JSON.stringify(new URL("../src/providers/fake/provider.ts", import.meta.url).href)};
  import { initDatabase, closeDatabase } from ${JSON.stringify(new URL("../src/persistence/database.ts", import.meta.url).href)};
  import { SessionStore } from ${JSON.stringify(new URL("../src/persistence/session-store.ts", import.meta.url).href)};
  import { MessageStore } from ${JSON.stringify(new URL("../src/persistence/message-store.ts", import.meta.url).href)};
  import { TurnStore } from ${JSON.stringify(new URL("../src/persistence/turn-store.ts", import.meta.url).href)};

  initDatabase(":memory:");
  const manager = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    "chatgpt-web": new FakeConversationProvider(),
  });
  const server = new AgentChatGptMcpServer(manager, {
    defaultProvider: "chatgpt-web",
    defaultModel: "fake-model",
    listModels: async () => ["fake-model"],
  });
  try {
    await server.run();
  } finally {
    closeDatabase();
  }
`;

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    throw new Error("MCP result did not contain content");
  }
  const content = (result as { content: unknown }).content as Array<{ type?: string; text?: string }>;
  const text = content[0]?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain text");
  return text;
}

test("MCP stdio subprocess stays alive across create, ask, continue, then exits on disconnect", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", childSource],
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-stdio-lifecycle-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain("chatgpt_create_session");

    const created = await client.callTool({
      name: "chatgpt_create_session",
      arguments: { name: `mcp-subprocess-${Date.now()}` },
    });
    expect(created.isError).not.toBe(true);
    const session = JSON.parse(resultText(created));

    const asked = await client.callTool({
      name: "chatgpt_ask",
      arguments: { session_id: session.id, message: "remember the bridge" },
    });
    expect(asked.isError).not.toBe(true);
    expect(JSON.parse(resultText(asked)).text).toBe("This is a fake response.");

    const continued = await client.callTool({
      name: "chatgpt_continue",
      arguments: { session_id: session.id, message: "continue" },
    });
    expect(continued.isError).not.toBe(true);
    expect(JSON.parse(resultText(continued)).session_id).toBe(session.id);

    const details = await client.callTool({
      name: "chatgpt_get_session",
      arguments: { session_id: session.id },
    });
    expect(details.isError).not.toBe(true);
  } finally {
    await client.close();
  }
  expect(transport.pid).toBeNull();
});
