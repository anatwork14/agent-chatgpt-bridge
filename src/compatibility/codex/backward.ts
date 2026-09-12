import type { BridgeTurnRequest, BridgeMessage, BridgeContentPart, BridgeToolDefinition } from "../../core/domain";
import type { CodexParsedRequest, CodexContentPart, CodexTool, CodexMessage, CodexRequestOptions } from "../../types";

export function bridgeContentPartToCodex(part: BridgeContentPart): CodexContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image") {
    return {
      type: "image",
      imageUrl: part.source.type === "data_url" ? part.source.dataUrl : part.source.path, // or uri
      detail: part.detail || "auto",
    };
  }
  if (part.type === "resource") {
    return { type: "text", text: `Resource attached: ${part.uri}` }; // fallback
  }
  return { type: "text", text: JSON.stringify(part) };
}

export function bridgeMessageToCodex(msg: BridgeMessage): CodexMessage {
  const content = msg.content.map(bridgeContentPartToCodex);
  if (msg.role === "assistant") {
    return { role: "assistant", content: content as any, timestamp: Date.now() }; // simplify for shim
  }
  if (msg.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: (msg.metadata?.toolCallId as string) || "unknown",
      toolName: (msg.metadata?.toolName as string) || "unknown",
      content,
      isError: false,
      timestamp: Date.now(),
    };
  }
  // User or system
  if (msg.role === "system") {
      return { role: "developer", content, timestamp: Date.now() };
  }
  return { role: "user", content, timestamp: Date.now() };
}

export function bridgeTurnRequestToCodexParsedRequest(bridgeReq: BridgeTurnRequest): CodexParsedRequest {
  const messages: CodexMessage[] = bridgeReq.messages.map(bridgeMessageToCodex);
  const tools: CodexTool[] = (bridgeReq.tools || []).map(t => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema,
    namespace: t.namespace,
  }));

  const options: CodexRequestOptions = (bridgeReq.metadata?.options as CodexRequestOptions) || {};
  if (bridgeReq.output && bridgeReq.output.type === "json_schema" && bridgeReq.output.schema) {
      options.outputFormat = {
          type: "json_schema",
          name: "output",
          schema: bridgeReq.output.schema
      };
  }

  return {
    modelId: bridgeReq.model.model,
    stream: bridgeReq.stream,
    context: {
      messages,
      tools,
      systemPrompt: bridgeReq.messages.filter(m => m.role === "system").map(m => m.content[0]?.type === "text" ? m.content[0].text : ""),
    },
    options,
  };
}
