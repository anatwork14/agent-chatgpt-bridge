import type {
  CodexParsedRequest,
  CodexContentPart,
  CodexTool,
  CodexMessage,
  CodexImageContent,
  CodexAssistantContentPart,
} from "../../types";
import type {
  BridgeTurnRequest,
  BridgeMessage,
  BridgeContentPart,
  BridgeToolDefinition,
} from "../../core/domain";

export function codexContentPartToBridge(part: CodexContentPart | string): BridgeContentPart {
  if (typeof part === "string") return { type: "text", text: part };
  if (part.type === "text") return { type: "text", text: part.text };

  const image = part as CodexImageContent;
  if (image.imageUrl.startsWith("data:")) {
    return {
      type: "image",
      source: { type: "data_url", dataUrl: image.imageUrl },
      detail: image.detail === "low" || image.detail === "high" || image.detail === "auto"
        ? image.detail
        : undefined,
    };
  }
  // Remote images stay resources at the generic boundary; the bridge never downloads an
  // arbitrary URL merely to satisfy the image data-url representation.
  return { type: "resource", uri: image.imageUrl };
}

function ordinaryContent(content: string | CodexContentPart[]): BridgeContentPart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map(codexContentPartToBridge);
}

function assistantContent(content: CodexAssistantContentPart[]): BridgeContentPart[] {
  // Preserve user-visible assistant text only. Hidden/raw reasoning is deliberately not promoted
  // into the generic transcript, while tool lifecycle remains represented by explicit tool-result
  // messages/events rather than prose serialization.
  return content.flatMap(part => part.type === "text"
    ? [{ type: "text" as const, text: part.text }]
    : []);
}

export function codexMessageToBridge(message: CodexMessage, index: number): BridgeMessage {
  let role: BridgeMessage["role"];
  let content: BridgeContentPart[];
  let metadata: Record<string, unknown> = { originalRole: message.role };

  switch (message.role) {
    case "assistant":
      role = "assistant";
      content = assistantContent(message.content);
      break;
    case "toolResult":
      role = "tool";
      content = ordinaryContent(message.content);
      metadata = {
        ...metadata,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        toolNamespace: message.toolNamespace,
        isError: message.isError,
      };
      break;
    case "developer":
      role = "system";
      content = ordinaryContent(message.content);
      break;
    case "agentMessage":
    case "user":
      role = "user";
      content = ordinaryContent(message.content);
      break;
  }

  return {
    id: `msg_${index}`,
    role,
    content,
    createdAt: new Date(message.timestamp).toISOString(),
    metadata,
  };
}

export function codexToolToBridge(tool: CodexTool): BridgeToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    mode: tool.freeform ? "freeform" : "structured",
    namespace: tool.namespace,
  };
}

function outputSchema(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  const schema = parsed.options.outputFormat?.schema;
  return schema !== null && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : undefined;
}

export function codexParsedRequestToBridgeTurnRequest(
  parsed: CodexParsedRequest,
  requestId: string,
  sessionId: string,
): BridgeTurnRequest {
  const messages: BridgeMessage[] = [];

  if (parsed.context.systemPrompt) {
    parsed.context.systemPrompt.forEach((prompt, index) => {
      messages.push({
        id: `sys_${index}`,
        role: "system",
        content: [{ type: "text", text: prompt }],
        createdAt: new Date().toISOString(),
      });
    });
  }

  parsed.context.messages.forEach((message, index) => {
    messages.push(codexMessageToBridge(message, messages.length + index));
  });

  const schema = outputSchema(parsed);
  return {
    requestId,
    sessionId,
    source: "codex",
    model: {
      provider: "chatgpt-web",
      model: parsed.modelId,
      effort: parsed.options.reasoning,
    },
    messages,
    tools: parsed.context.tools?.map(codexToolToBridge),
    stream: parsed.stream,
    metadata: { options: parsed.options },
    ...(parsed.options.outputFormat && schema
      ? { output: { type: "json_schema" as const, schema } }
      : {}),
  };
}
