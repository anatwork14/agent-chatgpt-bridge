export type BridgeContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source:
        | { type: "data_url"; dataUrl: string }
        | { type: "local_file"; path: string };
      detail?: "low" | "high" | "auto";
    }
  | {
      type: "resource";
      uri: string;
      name?: string;
      mimeType?: string;
    };

export interface BridgeMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: BridgeContentPart[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface BridgeModelSelection {
  provider: "chatgpt-web";
  model: string;
  effort?: string;
}

export interface BridgeEnvironment {
  cwd?: string;
  workspaceRoots?: string[];
  sandboxPolicy?: string;
  metadata?: Record<string, unknown>;
}

export interface BridgeToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  mode?: "structured" | "freeform";
  namespace?: string;
}

export interface BridgeOutputContract {
  type: "text" | "json_schema";
  schema?: Record<string, unknown>;
}

export interface BridgeTurnRequest {
  requestId: string;
  sessionId: string;
  source:
    | "codex"
    | "responses"
    | "mcp"
    | "cli"
    | "relay"
    | "internal";
  model: BridgeModelSelection;
  messages: BridgeMessage[];
  incrementalMessages?: BridgeMessage[];
  attachments?: BridgeContentPart[];
  tools?: BridgeToolDefinition[];
  environment?: BridgeEnvironment;
  output?: BridgeOutputContract;
  stream: boolean;
  metadata?: Record<string, unknown>;
}

export interface BridgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface BridgeTurnResult {
  requestId: string;
  sessionId: string;
  turnId: string;
  status:
    | "completed"
    | "cancelled"
    | "failed"
    | "incomplete";

  text: string;

  structured?: unknown;

  usage?: BridgeUsage;

  providerMetadata?: Record<string, unknown>;

  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type SessionStatus =
  | "created"
  | "ready"
  | "busy"
  | "closing"
  | "closed"
  | "error";

export interface BridgeSession {
  id: string;
  name?: string;

  provider: "chatgpt-web";

  model: string;
  effort?: string;

  status: SessionStatus;

  conversationEpoch: number;

  createdAt: string;
  updatedAt: string;
  lastTurnAt?: string;

  metadata?: Record<string, unknown>;
}

export interface CollaborationRun {
  id: string;
  sessionId: string;
  agentAdapterId: string;
  objective: string;
  status:
    | "created"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted";
  round: number;
  budget: {
    maxRounds: number;
    maxWallClockMs: number;
    maxConsecutiveFailures: number;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  finalSummary?: string;
}

export type AgentDecision =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "done";
      summary: string;
    }
  | {
      type: "pause";
      reason: string;
    }
  | {
      type: "error";
      message: string;
      retryable: boolean;
    };

export interface AgentTurnInput {
  runId: string;
  objective: string;
  round: number;
  lastChatGptResponse?: {
    text: string;
  };
}

export interface ExternalAgentAdapter {
  readonly id: string;
  next(
    input: AgentTurnInput,
    ctx: { signal?: AbortSignal }
  ): Promise<AgentDecision>;
}
