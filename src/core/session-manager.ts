import type { SessionStatus } from "./domain";
import { generateSessionId, generateTurnId } from "./ids";
import type { ConversationProvider } from "../providers/provider";
import { SessionStore, type SessionData } from "../persistence/session-store";
import { MessageStore, type MessageData } from "../persistence/message-store";
import { TurnStore } from "../persistence/turn-store";
import { BridgeError } from "./errors";
import { Mutex } from "./mutex";
import type { BridgeEvent } from "./events";
import type { BridgeTurnRequest } from "./domain";

export interface CreateSessionParams {
  name?: string;
  provider: string;
  model: string;
  effort?: string;
  metadata?: Record<string, unknown>;
}

export class SessionManager {
  private sessionLocks = new Map<string, Mutex>();

  constructor(
    private sessionStore: SessionStore,
    private messageStore: MessageStore,
    private turnStore: TurnStore,
    private providers: Record<string, ConversationProvider>
  ) {}

  private getLock(sessionId: string): Mutex {
    if (!this.sessionLocks.has(sessionId)) {
      this.sessionLocks.set(sessionId, new Mutex());
    }
    return this.sessionLocks.get(sessionId)!;
  }

  async create(params: CreateSessionParams): Promise<SessionData> {
    const id = generateSessionId();
    const session: SessionData = {
      id,
      name: params.name,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      status: "created",
      conversationEpoch: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: params.metadata,
    };
    this.sessionStore.create(session);
    return session;
  }

  async get(id: string): Promise<SessionData> {
    const session = this.sessionStore.get(id);
    if (!session) throw new BridgeError("session_not_found", `Session ${id} not found`, false);
    return session;
  }

  async list(): Promise<SessionData[]> {
    const db = require("../persistence/database").getDatabase();
    const rows = db.query("SELECT * FROM sessions ORDER BY created_at DESC").all();
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      status: row.status,
      conversationEpoch: row.conversation_epoch,
      continuityMode: row.continuity_mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTurnAt: row.last_turn_at,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }

  async send(
    sessionId: string,
    request: Omit<BridgeTurnRequest, "sessionId" | "requestId"> & { requestId?: string },
    ctx: { signal?: AbortSignal, emit: (event: BridgeEvent) => void }
  ) {
    const lock = this.getLock(sessionId);
    const unlock = await lock.acquire();
    
    try {
      const session = await this.get(sessionId);
      if (session.status === "closed") {
        throw new BridgeError("session_closed", `Session ${sessionId} is closed`);
      }

      this.sessionStore.update(sessionId, { status: "busy", lastTurnAt: new Date().toISOString() });
      const provider = this.providers[session.provider];
      if (!provider) {
        throw new BridgeError("invalid_model", `Provider ${session.provider} not found`);
      }

      const turnReq: BridgeTurnRequest = {
        ...request,
        sessionId,
        requestId: request.requestId || generateTurnId(),
      };

      // Create turn record
      this.turnStore.create({
        id: turnReq.requestId,
        requestId: turnReq.requestId,
        sessionId,
        status: "started",
        source: request.source,
        startedAt: new Date().toISOString(),
      });

      const result = await provider.runTurn(turnReq, ctx);

      // Append user messages and assistant result
      for (const msg of request.messages) {
        this.messageStore.create({
          id: msg.id,
          sessionId,
          role: msg.role,
          contentJson: JSON.stringify(msg.content),
          createdAt: msg.createdAt,
          metadataJson: msg.metadata ? JSON.stringify(msg.metadata) : undefined,
        });
      }

      if (result.status === "completed") {
        this.messageStore.create({
          id: `msg_${result.turnId}`,
          sessionId,
          role: "assistant",
          contentJson: JSON.stringify([{ type: "text", text: result.text }]),
          createdAt: new Date().toISOString(),
        });
      }

      this.sessionStore.update(sessionId, { status: "ready" });
      return result;
    } catch (e) {
      this.sessionStore.update(sessionId, { status: "ready" });
      throw e;
    } finally {
      unlock();
    }
  }

  async cancel(sessionId: string, turnId: string) {
    const session = await this.get(sessionId);
    if (session.status === "closed") throw new BridgeError("session_closed", `Session closed`);
    const provider = this.providers[session.provider];
    if (provider?.cancelTurn) {
      await provider.cancelTurn(sessionId, turnId);
    }
  }

  async close(sessionId: string) {
    const session = await this.get(sessionId);
    if (session.status === "closed") return;
    const provider = this.providers[session.provider];
    if (provider?.closeSession) {
      await provider.closeSession(sessionId);
    }
    this.sessionStore.update(sessionId, { status: "closed" });
  }
}
