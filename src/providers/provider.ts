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

  /**
   * Optional targeted model validation hook. Meta-providers should implement this so validating
   * one provider's model cannot require every optional downstream provider to be healthy.
   */
  validateModel?(model: string): Promise<void>;

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
