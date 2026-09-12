import type { ConversationProvider, ProviderCapabilities } from "../provider";
import type { BridgeTurnRequest, BridgeTurnResult } from "../../core/domain";
import type { BridgeEvent } from "../../core/events";
import { bridgeTurnRequestToCodexParsedRequest } from "../../compatibility/codex/backward";
import { createChatGptWebAdapter } from "../../adapters/chatgpt-web";
import type { CodexProviderConfig, AdapterEvent } from "../../types";

export class ChatGPTWebConversationProvider implements ConversationProvider {
  public readonly name = "chatgpt-web";
  private adapter: ReturnType<typeof createChatGptWebAdapter>;

  constructor(config: CodexProviderConfig, dependencies = {}) {
    this.adapter = createChatGptWebAdapter(config, dependencies);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportsImages: true,
      supportsTools: true,
      models: ["auto", "gpt-4o", "gpt-4"],
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: {
      signal?: AbortSignal;
      emit(event: BridgeEvent): void;
    }
  ): Promise<BridgeTurnResult> {
    const parsed = bridgeTurnRequestToCodexParsedRequest(request);
    
    let result: BridgeTurnResult = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.requestId, // Simplification: using request ID as turn ID
      status: "incomplete",
      text: "",
    };

    const handleEvent = (event: AdapterEvent) => {
      if (event.type === "turn_started") {
        ctx.emit({ type: "turn.started", sessionId: request.sessionId, turnId: result.turnId });
      } else if (event.type === "text_delta") {
        result.text += event.delta;
        ctx.emit({ type: "text.delta", sessionId: request.sessionId, turnId: result.turnId, delta: event.delta });
      } else if (event.type === "error") {
        result.status = "failed";
        result.error = {
          code: event.code || "provider_error",
          message: event.message,
          retryable: event.retryable !== false,
        };
        ctx.emit({
          type: "turn.failed",
          sessionId: request.sessionId,
          turnId: result.turnId,
          error: result.error,
        });
      } else if (event.type === "completed") {
        result.status = "completed";
        result.text = event.text || result.text;
        ctx.emit({
          type: "turn.completed",
          sessionId: request.sessionId,
          turnId: result.turnId,
          result,
        });
      }
    };

    const incoming = { headers: new Headers(), abortSignal: ctx.signal };
    
    try {
      await this.adapter.runTurn(parsed, incoming, handleEvent);
      if (result.status === "incomplete") {
         result.status = "completed";
      }
    } catch (e) {
      result.status = "failed";
      result.error = {
        code: "internal_error",
        message: e instanceof Error ? e.message : String(e),
        retryable: false
      };
      ctx.emit({
        type: "turn.failed",
        sessionId: request.sessionId,
        turnId: result.turnId,
        error: result.error,
      });
    }

    return result;
  }
}
