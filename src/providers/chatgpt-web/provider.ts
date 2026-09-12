import type { ConversationProvider, ProviderCapabilities } from "../provider";
import type { BridgeTurnRequest, BridgeTurnResult, BridgeUsage } from "../../core/domain";
import type { BridgeEvent } from "../../core/events";
import { bridgeTurnRequestToCodexParsedRequest } from "../../compatibility/codex/backward";
import { createChatGptWebAdapter } from "../../adapters/chatgpt-web";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebAccountCapabilities,
} from "../../chatgpt-web-models";
import type { CodexProviderConfig, AdapterEvent, CodexUsage } from "../../types";

function bridgeUsage(usage: CodexUsage | undefined): BridgeUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
}

export class ChatGPTWebConversationProvider implements ConversationProvider {
  public readonly name = "chatgpt-web";
  private readonly adapter: ReturnType<typeof createChatGptWebAdapter>;
  private readonly config: CodexProviderConfig;

  constructor(config: CodexProviderConfig, dependencies = {}) {
    this.config = config;
    this.adapter = createChatGptWebAdapter(config, dependencies);
  }

  private accountCapabilities(): ChatGptWebAccountCapabilities {
    const web = this.config.chatgptWeb ?? {};
    const manual = web.browserInteractionMode === "manual";
    return {
      browserInteractionMode: manual ? "manual" : "automatic",
      solAvailable: manual ? false : web.solAvailable !== false,
      proAvailable: manual ? false : web.proAvailable === true,
      experimentalBiggerContext: web.experimentalBiggerContext === true,
      zeroRiskProEnabled: manual
        && (this.config.models ?? []).includes(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL),
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const capabilities = this.accountCapabilities();
    const routes = availableChatGptWebModelRoutes(capabilities);
    return {
      supportsImages: capabilities.browserInteractionMode !== "manual",
      supportsTools: this.config.chatgptWeb?.localToolsEnabled === true,
      models: routes.map(route => route.slug),
    };
  }

  private normalizeRequest(request: BridgeTurnRequest): BridgeTurnRequest {
    if (!isChatGptWebModelSlug(request.model.model)) return request;
    const route = requireChatGptWebModelRoute(request.model.model, this.accountCapabilities());
    return {
      ...request,
      model: {
        provider: this.name,
        model: route.backendModel,
        effort: route.adapterEffort,
      },
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: {
      signal?: AbortSignal;
      emit(event: BridgeEvent): void;
    },
  ): Promise<BridgeTurnResult> {
    const normalized = this.normalizeRequest(request);
    const parsed = bridgeTurnRequestToCodexParsedRequest(normalized);
    // The session manager owns the logical turn id. Keeping provider and persistence identity
    // identical makes cancellation/idempotency deterministic across protocol surfaces.
    const turnId = request.requestId;

    let terminalSeen = false;
    let activeTool: { id: string; name: string; arguments: string } | undefined;
    const result: BridgeTurnResult = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId,
      status: "incomplete",
      text: "",
    };

    ctx.emit({ type: "turn.started", sessionId: request.sessionId, turnId });

    const fail = (status: "failed" | "cancelled" | "incomplete", code: string, message: string, retryable: boolean) => {
      if (terminalSeen) return;
      terminalSeen = true;
      result.status = status;
      result.error = { code, message, retryable };
      ctx.emit({
        type: "turn.failed",
        sessionId: request.sessionId,
        turnId,
        error: result.error,
      });
    };

    const handleEvent = (event: AdapterEvent): void => {
      switch (event.type) {
        case "heartbeat":
        case "thinking_signature":
        case "redacted_thinking":
        case "reasoning_raw_delta":
        case "assistant_boundary":
          return;

        case "text_delta":
          result.text += event.text;
          ctx.emit({ type: "text.delta", sessionId: request.sessionId, turnId, delta: event.text });
          return;

        case "thinking_delta":
          ctx.emit({
            type: "reasoning.summary.delta",
            sessionId: request.sessionId,
            turnId,
            delta: event.thinking,
          });
          return;

        case "tool_call_start":
          activeTool = { id: event.id, name: event.name, arguments: "" };
          return;

        case "tool_call_delta":
          if (activeTool) activeTool.arguments += event.arguments;
          return;

        case "tool_call_end": {
          if (!activeTool) return;
          let args: unknown = activeTool.arguments;
          try {
            args = activeTool.arguments ? JSON.parse(activeTool.arguments) : {};
          } catch {
            // Keep the raw argument string; the outer capability layer remains authoritative.
          }
          ctx.emit({
            type: "tool.call",
            sessionId: request.sessionId,
            turnId,
            callId: activeTool.id,
            name: activeTool.name,
            arguments: args,
          });
          activeTool = undefined;
          return;
        }

        case "done":
          if (terminalSeen) return;
          terminalSeen = true;
          result.status = "completed";
          result.usage = bridgeUsage(event.usage);
          result.providerMetadata = {
            stopReason: event.stopReason,
            endTurn: event.endTurn,
            providerState: event.providerState,
          };
          ctx.emit({ type: "turn.completed", sessionId: request.sessionId, turnId, result });
          return;

        case "incomplete":
          result.usage = bridgeUsage(event.usage);
          result.providerMetadata = {
            reason: event.reason,
            endTurn: event.endTurn,
            providerState: event.providerState,
          };
          fail(
            "incomplete",
            "provider_incomplete",
            event.message || `ChatGPT Web turn ended incomplete: ${event.reason}`,
            event.retryable === true,
          );
          return;

        case "error":
          result.usage = bridgeUsage(event.usage);
          fail(
            "failed",
            event.code || event.errorType || "provider_error",
            event.message,
            event.retryable === true,
          );
          return;
      }
    };

    try {
      await this.adapter.runTurn(
        parsed,
        { headers: new Headers(), abortSignal: ctx.signal },
        handleEvent,
      );

      if (!terminalSeen) {
        fail(
          ctx.signal?.aborted ? "cancelled" : "failed",
          ctx.signal?.aborted ? "client_cancelled" : "provider_terminal_missing",
          ctx.signal?.aborted
            ? "ChatGPT Web turn was cancelled"
            : "ChatGPT Web adapter returned without a terminal event",
          false,
        );
      }
    } catch (error) {
      if (!terminalSeen) {
        const cancelled = ctx.signal?.aborted
          || (error instanceof DOMException && error.name === "AbortError");
        fail(
          cancelled ? "cancelled" : "failed",
          cancelled ? "client_cancelled" : "provider_exception",
          error instanceof Error ? error.message : String(error),
          false,
        );
      }
    }

    return result;
  }
}
