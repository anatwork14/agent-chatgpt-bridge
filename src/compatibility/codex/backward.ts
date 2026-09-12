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
  };
}
