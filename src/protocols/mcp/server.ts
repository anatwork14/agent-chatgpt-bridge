import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "../../core/session-manager";

export class AgentChatGptMcpServer {
  public server: Server;

  constructor(private sessionManager: SessionManager) {
    this.server = new Server(
      {
        name: "agent-chatgpt-bridge",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "chatgpt_create_session",
          description: "Create a new isolated ChatGPT session.",
          inputSchema: { type: "object", properties: { name: { type: "string" }, model: { type: "string" }, effort: { type: "string" } } }
        },
        {
          name: "chatgpt_ask",
          description: "Send a message to ChatGPT.",
          inputSchema: { type: "object", properties: { message: { type: "string" }, session_id: { type: "string" }, model: { type: "string" }, effort: { type: "string" } }, required: ["message"] }
        },
        {
          name: "chatgpt_continue",
          description: "Continue an existing ChatGPT session with a new message.",
          inputSchema: { type: "object", properties: { session_id: { type: "string" }, message: { type: "string" } }, required: ["session_id", "message"] }
        },
        {
          name: "chatgpt_get_session",
          description: "Get session details.",
          inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] }
        },
        {
          name: "chatgpt_list_sessions",
          description: "List active sessions.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "chatgpt_cancel",
          description: "Cancel an active turn in a session.",
          inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] }
        },
        {
          name: "chatgpt_close_session",
          description: "Close an active session.",
          inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] }
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return this.handleToolCall(request.params.name, request.params.arguments as Record<string, unknown>);
    });
  }

  async handleToolCall(name: string, args: Record<string, unknown>) {
    try {
      switch (name) {
        case "chatgpt_create_session": {
          const session = await this.sessionManager.create({
            name: args.name as string,
            provider: "chatgpt-web",
            model: (args.model as string) || "auto",
            effort: args.effort as string,
          });
          return { content: [{ type: "text", text: JSON.stringify(session) }] };
        }
        case "chatgpt_ask": {
          let sessionId = args.session_id as string;
          if (!sessionId) {
            const session = await this.sessionManager.create({
              provider: "chatgpt-web",
              model: (args.model as string) || "auto",
              effort: args.effort as string,
            });
            sessionId = session.id;
          }
          const result = await this.sessionManager.send(sessionId, {
            source: "mcp",
            model: { provider: "chatgpt-web", model: (args.model as string) || "auto" },
            messages: [{ id: "mcp_" + Date.now(), role: "user", content: [{ type: "text", text: args.message as string }], createdAt: new Date().toISOString() }],
            stream: false
          }, { emit: () => {} });
          return { content: [{ type: "text", text: result.text }] };
        }
        case "chatgpt_continue": {
          const result = await this.sessionManager.send(args.session_id as string, {
            source: "mcp",
            model: { provider: "chatgpt-web", model: "auto" },
            messages: [{ id: "mcp_" + Date.now(), role: "user", content: [{ type: "text", text: args.message as string }], createdAt: new Date().toISOString() }],
            stream: false
          }, { emit: () => {} });
          return { content: [{ type: "text", text: result.text }] };
        }
        case "chatgpt_get_session": {
          const session = await this.sessionManager.get(args.session_id as string);
          return { content: [{ type: "text", text: JSON.stringify(session) }] };
        }
        case "chatgpt_list_sessions": {
          const sessions = await this.sessionManager.list();
          return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
        }
        case "chatgpt_cancel": {
          await this.sessionManager.cancel(args.session_id as string, "latest");
          return { content: [{ type: "text", text: "Cancelled" }] };
        }
        case "chatgpt_close_session": {
          await this.sessionManager.close(args.session_id as string);
          return { content: [{ type: "text", text: "Closed" }] };
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
