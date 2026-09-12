import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { generateId } from "../../core/ids";
import { BridgeError } from "../../core/errors";
import { SessionManager } from "../../core/session-manager";

export interface AgentChatGptMcpOptions {
  defaultProvider?: string;
  defaultModel?: string;
  listModels?: () => Promise<string[]>;
}

function stringArg(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new BridgeError("invalid_request", `${key} must be a non-empty string`, false);
  }
  return value;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export class AgentChatGptMcpServer {
  public readonly server: Server;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly options: AgentChatGptMcpOptions = {},
  ) {
    this.server = new Server(
      { name: "agent-chatgpt-bridge", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "chatgpt_create_session",
          description: "Create a new isolated ChatGPT session.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              model: { type: "string" },
              effort: { type: "string" },
            },
          },
        },
        {
          name: "chatgpt_ask",
          description: "Ask ChatGPT, optionally continuing an existing bridge session.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
              session_id: { type: "string" },
              model: { type: "string" },
              effort: { type: "string" },
            },
            required: ["message"],
          },
        },
        {
          name: "chatgpt_continue",
          description: "Continue an existing ChatGPT session with a new message.",
          inputSchema: {
            type: "object",
            properties: {
              session_id: { type: "string" },
              message: { type: "string" },
            },
            required: ["session_id", "message"],
          },
        },
        {
          name: "chatgpt_get_session",
          description: "Get bridge session details.",
          inputSchema: {
            type: "object",
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
          },
        },
        {
          name: "chatgpt_list_sessions",
          description: "List bridge sessions.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "chatgpt_list_models",
          description: "List ChatGPT Web model routes currently available to the configured account.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "chatgpt_cancel",
          description: "Cancel the active turn in a bridge session.",
          inputSchema: {
            type: "object",
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
          },
        },
        {
          name: "chatgpt_close_session",
          description: "Close a bridge session and release its provider conversation.",
          inputSchema: {
            type: "object",
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      return this.handleToolCall(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );
    });
  }

  private async createSession(args: Record<string, unknown>) {
    const model = stringArg(args, "model") ?? this.options.defaultModel;
    if (!model) {
      throw new BridgeError(
        "invalid_request",
        "model is required unless the bridge has an explicit default model configured",
        false,
      );
    }
    return this.sessionManager.create({
      name: stringArg(args, "name"),
      provider: this.options.defaultProvider ?? "chatgpt-web",
      model,
      effort: stringArg(args, "effort"),
    });
  }

  private async send(sessionId: string, message: string) {
    const session = await this.sessionManager.get(sessionId);
    return this.sessionManager.send(
      session.id,
      {
        source: "mcp",
        model: {
          provider: session.provider,
          model: session.model,
          effort: session.effort,
        },
        messages: [{
          id: generateId("msg"),
          role: "user",
          content: [{ type: "text", text: message }],
          createdAt: new Date().toISOString(),
        }],
        stream: false,
      },
      { emit: () => undefined },
    );
  }

  async handleToolCall(name: string, args: Record<string, unknown>) {
    try {
      switch (name) {
        case "chatgpt_create_session":
          return textResult(await this.createSession(args));

        case "chatgpt_ask": {
          const message = stringArg(args, "message", true)!;
          let sessionId = stringArg(args, "session_id");
          if (!sessionId) {
            const session = await this.createSession(args);
            sessionId = session.id;
          }
          const result = await this.send(sessionId, message);
          if (result.status !== "completed") {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ status: result.status, error: result.error }) }],
              isError: true,
            };
          }
          return textResult({ session_id: sessionId, turn_id: result.turnId, text: result.text, usage: result.usage });
        }

        case "chatgpt_continue": {
          const sessionId = stringArg(args, "session_id", true)!;
          const message = stringArg(args, "message", true)!;
          const result = await this.send(sessionId, message);
          if (result.status !== "completed") {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ status: result.status, error: result.error }) }],
              isError: true,
            };
          }
          return textResult({ session_id: sessionId, turn_id: result.turnId, text: result.text, usage: result.usage });
        }

        case "chatgpt_get_session":
          return textResult(await this.sessionManager.get(stringArg(args, "session_id", true)!));

        case "chatgpt_list_sessions":
          return textResult(await this.sessionManager.list());

        case "chatgpt_list_models":
          return textResult({ models: this.options.listModels ? await this.options.listModels() : [] });

        case "chatgpt_cancel": {
          const cancelled = await this.sessionManager.cancel(stringArg(args, "session_id", true)!, "latest");
          return textResult({ cancelled });
        }

        case "chatgpt_close_session": {
          await this.sessionManager.close(stringArg(args, "session_id", true)!);
          return textResult({ closed: true });
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      const payload = error instanceof BridgeError
        ? error.toJSON()
        : { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error), retryable: false } };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        isError: true,
      };
    }
  }

  async run(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }
}
