import { resolve } from "node:path";
import type {
  BridgeTurnRequest,
  BridgeMessage,
  BridgeContentPart,
} from "../../core/domain";
import type {
  CodexParsedRequest,
  CodexContentPart,
  CodexTool,
  CodexMessage,
  CodexRequestOptions,
  CodexAssistantContentPart,
} from "../../types";

function timestampOf(message: BridgeMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function bridgeContentPartToCodex(part: BridgeContentPart): CodexContentPart {
  if (part.type === "text") return { type: "text", text: part.text };

  if (part.type === "image") {
    if (part.source.type !== "data_url") {
      throw new Error(
        "Local-file image attachments must be validated and converted to a data URL before Codex compatibility translation",
      );
    }
    return {
      type: "image",
      imageUrl: part.source.dataUrl,
      detail: part.detail || "auto",
    };
  }

  return {
    type: "text",
    text: part.name ? `Resource ${part.name}: ${part.uri}` : `Resource: ${part.uri}`,
  };
}

function assistantContent(message: BridgeMessage): CodexAssistantContentPart[] {
  return message.content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "resource") {
      return {
        type: "text",
        text: part.name ? `Resource ${part.name}: ${part.uri}` : `Resource: ${part.uri}`,
      };
    }
    throw new Error("Assistant image history is not supported by the Codex compatibility shim");
  });
}

export function bridgeMessageToCodex(message: BridgeMessage): CodexMessage {
  const timestamp = timestampOf(message);

  if (message.role === "assistant") {
    return { role: "assistant", content: assistantContent(message), timestamp };
  }

  const content = message.content.map(bridgeContentPartToCodex);

  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: typeof message.metadata?.toolCallId === "string" ? message.metadata.toolCallId : "unknown",
      toolName: typeof message.metadata?.toolName === "string" ? message.metadata.toolName : "unknown",
      content,
      isError: message.metadata?.isError === true,
      timestamp,
    };
  }

  if (message.role === "system") {
    return { role: "developer", content, timestamp };
  }

  return { role: "user", content, timestamp };
}

function systemPrompt(messages: BridgeMessage[]): string[] | undefined {
  const prompts = messages
    .filter(message => message.role === "system")
    .map(message => message.content
      .filter((part): part is Extract<BridgeContentPart, { type: "text" }> => part.type === "text")
      .map(part => part.text)
      .join("\n"))
    .filter(Boolean);
  return prompts.length > 0 ? prompts : undefined;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Generic Agent→ChatGPT turns are intentionally read-only at the Codex compatibility boundary.
 * Reverse ChatGPT→local capabilities are a separate opt-in broker and must never be granted merely
 * because the underlying ChatGPT Web adapter was originally built for Codex Full mode.
 */
function genericEnvironment(bridgeReq: BridgeTurnRequest): { cwd: string; roots: string[]; xml: string } {
  const cwd = resolve(bridgeReq.environment?.cwd || process.cwd());
  const configuredRoots = (bridgeReq.environment?.workspaceRoots ?? []).map(root => resolve(root));
  const roots = [...new Set([cwd, ...configuredRoots])];
  const rootXml = roots.map(root => `<root>${xml(root)}</root>`).join("");
  return {
    cwd,
    roots,
    xml: `<environment_context>\n  <cwd>${xml(cwd)}</cwd>\n  <filesystem><workspace_roots>${rootXml}</workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>\n  <agent_chatgpt_bridge>true</agent_chatgpt_bridge>\n</environment_context>`,
  };
}

function currentUserMessage(bridgeReq: BridgeTurnRequest): BridgeMessage | undefined {
  const incremental = bridgeReq.incrementalMessages ?? [];
  return [...incremental, ...bridgeReq.messages]
    .findLast(message => message.role === "user");
}

function currentInstructionText(message: BridgeMessage | undefined): string {
  if (!message) return "Continue the current bridge session.";
  const text = message.content
    .filter((part): part is Extract<BridgeContentPart, { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();
  return text || "User supplied non-text content for this turn.";
}

function syntheticRawBody(bridgeReq: BridgeTurnRequest): Record<string, unknown> {
  const environment = genericEnvironment(bridgeReq);
  const current = currentUserMessage(bridgeReq);
  const turnMetadata = {
    thread_id: bridgeReq.sessionId,
    turn_id: bridgeReq.requestId,
    request_kind: "turn",
    sandbox: "read-only",
    workspaces: Object.fromEntries(environment.roots.map(root => [root, {}])),
  };
  const itemMetadata = { turn_id: bridgeReq.requestId };

  return {
    model: bridgeReq.model.model,
    stream: bridgeReq.stream,
    prompt_cache_key: bridgeReq.sessionId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
    metadata: {
      agent_chatgpt_bridge: true,
      bridge_session_id: bridgeReq.sessionId,
    },
    input: [
      {
        type: "message",
        id: `msg_bridge_env_${bridgeReq.requestId}`,
        role: "user",
        content: [{ type: "input_text", text: environment.xml }],
        internal_chat_message_metadata_passthrough: itemMetadata,
      },
      {
        type: "message",
        id: current?.id || `msg_bridge_user_${bridgeReq.requestId}`,
        role: "user",
        content: [{ type: "input_text", text: currentInstructionText(current) }],
        internal_chat_message_metadata_passthrough: itemMetadata,
      },
    ],
  };
}

export function bridgeTurnRequestToCodexParsedRequest(bridgeReq: BridgeTurnRequest): CodexParsedRequest {
  // System messages become the canonical Codex system prompt only; duplicating them as developer
  // history changes semantics and inflates every reconstructed generic session.
  const messages: CodexMessage[] = bridgeReq.messages
    .filter(message => message.role !== "system")
    .map(bridgeMessageToCodex);

  const tools: CodexTool[] = (bridgeReq.tools || []).map(tool => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema || { type: "object", properties: {} },
    namespace: tool.namespace,
    freeform: tool.mode === "freeform" ? true : undefined,
  }));

  const options: CodexRequestOptions = {
    ...((bridgeReq.metadata?.options as CodexRequestOptions | undefined) || {}),
  };
  if (bridgeReq.model.effort && options.reasoning === undefined) {
    options.reasoning = bridgeReq.model.effort;
  }
  if (bridgeReq.output?.type === "json_schema" && bridgeReq.output.schema) {
    options.outputFormat = {
      type: "json_schema",
      name: "bridge_output",
      strict: true,
      schema: bridgeReq.output.schema,
    };
  }

  return {
    modelId: bridgeReq.model.model,
    stream: bridgeReq.stream,
    context: {
      messages,
      tools: tools.length > 0 ? tools : undefined,
      systemPrompt: systemPrompt(bridgeReq.messages),
    },
    options,
    _rawBody: syntheticRawBody(bridgeReq),
  };
}
