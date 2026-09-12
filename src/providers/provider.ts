import type { BridgeTurnRequest, BridgeTurnResult } from "../core/domain";
import type { BridgeEvent } from "../core/events";

export interface ProviderCapabilities {
  supportsImages: boolean;
  supportsTools: boolean;
  models: string[];
}

export interface ConversationProvider {
  readonly name: string;

  capabilities(): Promise<ProviderCapabilities>;

  runTurn(
    request: BridgeTurnRequest,
    ctx: {
      signal?: AbortSignal;
      emit(event: BridgeEvent): void;
    },
  ): Promise<BridgeTurnResult>;

  cancelTurn?(
    sessionId: string,
    turnId: string,
  ): Promise<void>;

  closeSession?(
    sessionId: string,
  ): Promise<void>;
}
