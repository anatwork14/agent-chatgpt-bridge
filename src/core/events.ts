import { BridgeTurnResult } from "./domain";
import { BridgeErrorPayload } from "./errors";

export type BridgeEvent =
  | {
      type: "turn.started";
      sessionId: string;
      turnId: string;
    }
  | {
      type: "text.delta";
      sessionId: string;
      turnId: string;
      delta: string;
    }
  | {
      type: "reasoning.summary.delta";
      sessionId: string;
      turnId: string;
      delta: string;
    }
  | {
      type: "tool.call";
      sessionId: string;
      turnId: string;
      callId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool.result";
      sessionId: string;
      turnId: string;
      callId: string;
      result: unknown;
    }
  | {
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      result: BridgeTurnResult;
    }
  | {
      type: "turn.failed";
      sessionId: string;
      turnId: string;
      error: BridgeErrorPayload;
    };
