import type { CodexParsedRequest, CodexContentPart, CodexTool, CodexMessage, CodexImageContent } from "../../types";
import type { BridgeTurnRequest, BridgeMessage, BridgeContentPart, BridgeToolDefinition } from "../../core/domain";

export function codexContentPartToBridge(part: CodexContentPart | string): BridgeContentPart {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image") {
    const imgPart = part as CodexImageContent;
    // Assuming dataUrl starts with data: and local file paths don't.
    // In practice, Codex sends URLs or data URIs
    const source = imgPart.imageUrl.startsWith("data:") 
      ? { type: "data_url" as const, dataUrl: imgPart.imageUrl }
      : { type: "resource" as const, uri: imgPart.imageUrl }; // fallback to resource for urls
    if (source.type === "resource") {
        return { type: "resource", uri: imgPart.imageUrl };
    }
    return { 
      type: "image", 
      source: source,
      detail: imgPart.detail as "low" | "high" | "auto" | undefined
    };
  }
  // fallback for unsupported types
  return { type: "text", text: JSON.stringify(part) };
}

export function codexMessageToBridge(msg: CodexMessage, index: number): BridgeMessage {
  const content: BridgeContentPart[] = Array.isArray(msg.content) 
    ? msg.content.map(codexContentPartToBridge)
    : [codexContentPartToBridge(msg.content)];

  let role: BridgeMessage["role"] = "user";
  if (msg.role === "assistant") role = "assistant";
  else if (msg.role === "toolResult") role = "tool";
  else if (msg.role === "developer" || msg.role === "system") role = "system";

  return {
    id: `msg_${index}`,
    role,
    content,
    createdAt: new Date(msg.timestamp).toISOString(),
    metadata: {
      originalRole: msg.role,
      ...(msg.role === "toolResult" ? { toolCallId: msg.toolCallId, toolName: msg.toolName, toolNamespace: msg.toolNamespace } : {})
    }
  };
}

export function codexToolToBridge(tool: CodexTool): BridgeToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    mode: "structured", // Default mode for codex tools
    namespace: tool.namespace,
  };
}

export function codexParsedRequestToBridgeTurnRequest(
  parsed: CodexParsedRequest,
  requestId: string,
  sessionId: string
): BridgeTurnRequest {
  const messages: BridgeMessage[] = [];

  // Add system prompts as system messages
  if (parsed.context.systemPrompt && parsed.context.systemPrompt.length > 0) {
    for (const [index, prompt] of parsed.context.systemPrompt.entries()) {
      messages.push({
        id: `sys_${index}`,
        role: "system",
        content: [{ type: "text", text: prompt }],
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Add the rest of the messages
  messages.push(...parsed.context.messages.map((m, i) => codexMessageToBridge(m, messages.length + i)));

  const tools = parsed.context.tools?.map(codexToolToBridge) || [];

  return {
    requestId,
    sessionId,
    source: "codex",
    model: {
      provider: "chatgpt-web",
      model: parsed.modelId,
    },
    messages,
    tools,
    stream: parsed.stream,
    metadata: {
      options: parsed.options,
    },
    ...(parsed.options.outputFormat ? { output: { type: "json_schema", schema: parsed.options.outputFormat.schema } } : {})
  };
}
