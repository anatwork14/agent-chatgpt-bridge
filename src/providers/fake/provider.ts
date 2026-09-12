import type { ConversationProvider, ProviderCapabilities } from "../provider";
import type { BridgeTurnRequest, BridgeTurnResult } from "../../core/domain";
import type { BridgeEvent } from "../../core/events";
import { generateTurnId } from "../../core/ids";

export class FakeConversationProvider implements ConversationProvider {
  public readonly name = "fake";

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportsImages: true,
      supportsTools: true,
      models: ["fake-model"],
    };
  }

  async runTurn(
    request: BridgeTurnRequest,
    ctx: {
      signal?: AbortSignal;
      emit(event: BridgeEvent): void;
    }
  ): Promise<BridgeTurnResult> {
    const turnId = generateTurnId();
    ctx.emit({ type: "turn.started", sessionId: request.sessionId, turnId });

    const text = "This is a fake response.";
    ctx.emit({ type: "text.delta", sessionId: request.sessionId, turnId, delta: text });

    const result: BridgeTurnResult = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId,
      status: "completed",
      text,
    };
    
    ctx.emit({ type: "turn.completed", sessionId: request.sessionId, turnId, result });
    
    return result;
  }
}
