import type {
  BridgeContentPart,
  BridgeMessage,
  BridgeTurnRequest,
  BridgeTurnResult,
} from "./domain";
import { generateSessionId, generateTurnId } from "./ids";
import type { ConversationProvider } from "../providers/provider";
import { SessionStore, type SessionData } from "../persistence/session-store";
import { MessageStore, type MessageData } from "../persistence/message-store";
import { TurnStore, type PersistedTurnStatus } from "../persistence/turn-store";
import { BridgeError } from "./errors";
import { Mutex } from "./mutex";
import type { BridgeEvent } from "./events";
import { TurnScheduler } from "./turn-scheduler";
import {
  validateBridgeAttachments,
  validateBridgeMessages,
} from "./content-policy";

export interface CreateSessionParams {
  name?: string;
  provider: string;
  model: string;
  effort?: string;
  metadata?: Record<string, unknown>;
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  provider: ConversationProvider;
}

function parseMessage(row: MessageData): BridgeMessage {
  let content: BridgeContentPart[];
  let metadata: Record<string, unknown> | undefined;
  try {
    content = JSON.parse(row.contentJson) as BridgeContentPart[];
  } catch (error) {
    throw new BridgeError(
      "session_history_corrupt",
      `Stored message ${row.id} has invalid content JSON: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  if (!Array.isArray(content)) {
    throw new BridgeError("session_history_corrupt", `Stored message ${row.id} content is not an array`, false);
  }
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch (error) {
      throw new BridgeError(
        "session_history_corrupt",
        `Stored message ${row.id} has invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
  }
  if (row.role !== "system" && row.role !== "user" && row.role !== "assistant" && row.role !== "tool") {
    throw new BridgeError("session_history_corrupt", `Stored message ${row.id} has invalid role ${row.role}`, false);
  }
  return {
    id: row.id,
    role: row.role,
    content,
    createdAt: row.createdAt,
    metadata,
  };
}

function persistedStatus(result: BridgeTurnResult): PersistedTurnStatus {
  return result.status;
}

export class SessionManager {
  private readonly sessionLocks = new Map<string, Mutex>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private admittedTurns = 0;
  private shuttingDown = false;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly messageStore: MessageStore,
    private readonly turnStore: TurnStore,
    private readonly providers: Record<string, ConversationProvider>,
    private readonly turnScheduler: TurnScheduler = new TurnScheduler(),
  ) {}

  private getLock(sessionId: string): Mutex {
    let lock = this.sessionLocks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.sessionLocks.set(sessionId, lock);
    }
    return lock;
  }

  private providerFor(session: SessionData): ConversationProvider {
    const provider = this.providers[session.provider];
    if (!provider) {
      throw new BridgeError("provider_unavailable", `Provider ${session.provider} is not configured`, false);
    }
    return provider;
  }

  private async resolveSession(idOrName: string): Promise<SessionData> {
    const session = this.sessionStore.get(idOrName) ?? this.sessionStore.getByName(idOrName);
    if (!session) throw new BridgeError("session_not_found", `Session ${idOrName} not found`, false);
    return session;
  }

  private assertAcceptingTurns(): void {
    if (this.shuttingDown) {
      throw new BridgeError(
        "server_draining",
        "Bridge is shutting down and is not accepting new turns",
        true,
      );
    }
  }

  private admitTurn(): () => void {
    this.assertAcceptingTurns();
    const capacity = this.turnScheduler.snapshot();
    if (this.admittedTurns >= capacity.maxActive + capacity.maxQueued) {
      throw new BridgeError(
        "local_queue_full",
        `Bridge capacity is full (${capacity.maxActive} active + ${capacity.maxQueued} queued)`,
        true,
      );
    }
    this.admittedTurns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admittedTurns -= 1;
    };
  }

  async create(params: CreateSessionParams): Promise<SessionData> {
    this.assertAcceptingTurns();
    const provider = this.providers[params.provider];
    if (!provider) {
      throw new BridgeError("provider_unavailable", `Provider ${params.provider} is not configured`, false);
    }

    const capabilities = await provider.capabilities();
    if (capabilities.models.length > 0 && !capabilities.models.includes(params.model)) {
      throw new BridgeError(
        "model_unavailable",
        `Model ${params.model} is not available from provider ${params.provider}`,
        false,
      );
    }

    if (params.name && this.sessionStore.getByName(params.name)) {
      throw new BridgeError("session_conflict", `Session name ${params.name} already exists`, false);
    }

    const now = new Date().toISOString();
    const session: SessionData = {
      id: generateSessionId(),
      name: params.name,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      status: "ready",
      conversationEpoch: 0,
      continuityMode: "new",
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata,
    };
    this.sessionStore.create(session);
    return session;
  }

  async get(idOrName: string): Promise<SessionData> {
    return this.resolveSession(idOrName);
  }

  async list(): Promise<SessionData[]> {
    return this.sessionStore.list();
  }

  async transcript(idOrName: string): Promise<BridgeMessage[]> {
    const session = await this.resolveSession(idOrName);
    return this.messageStore.listBySession(session.id).map(parseMessage);
  }

  async send(
    idOrName: string,
    request: Omit<BridgeTurnRequest, "sessionId" | "requestId"> & { requestId?: string },
    ctx: { signal?: AbortSignal; emit: (event: BridgeEvent) => void },
  ): Promise<BridgeTurnResult> {
    if (ctx.signal?.aborted) {
      throw new BridgeError("client_cancelled", "Turn was cancelled before execution", false);
    }
    this.assertAcceptingTurns();

    // Resolve before admission so invalid session IDs cannot leak bounded-capacity accounting.
    const initialSession = await this.resolveSession(idOrName);
    const sessionId = initialSession.id;
    const releaseAdmission = this.admitTurn();
    let unlock: (() => void) | undefined;
    let releaseCapacity: (() => void) | undefined;
    let turnId: string | undefined;
    let externalAbort: (() => void) | undefined;

    try {
      unlock = await this.getLock(sessionId).acquire(ctx.signal);
      if (ctx.signal?.aborted) {
        throw new BridgeError("client_cancelled", "Turn was cancelled before provider execution", false);
      }
      this.assertAcceptingTurns();

      const session = await this.resolveSession(sessionId);
      if (session.status === "closed" || session.status === "closing") {
        throw new BridgeError("session_closed", `Session ${sessionId} is closed`, false);
      }
      if (session.status === "error") {
        throw new BridgeError("session_error", `Session ${sessionId} is in an error state`, false);
      }

      const provider = this.providerFor(session);
      const currentMessages = validateBridgeMessages(request.messages, request.environment);
      const attachments = validateBridgeAttachments(request.attachments, request.environment);
      const history = this.messageStore.listBySession(sessionId).map(parseMessage);
      turnId = request.requestId || generateTurnId();

      releaseCapacity = await this.turnScheduler.acquire(
        request.source === "relay" ? "normal" : "interactive",
        ctx.signal,
      );
      this.assertAcceptingTurns();

      const turnReq: BridgeTurnRequest = {
        ...request,
        sessionId,
        requestId: turnId,
        model: {
          provider: session.provider,
          model: session.model,
          effort: session.effort,
        },
        messages: [...history, ...currentMessages],
        incrementalMessages: currentMessages,
        attachments,
      };

      const controller = new AbortController();
      if (ctx.signal) {
        externalAbort = () => controller.abort(ctx.signal?.reason);
        ctx.signal.addEventListener("abort", externalAbort, { once: true });
      }
      this.activeTurns.set(sessionId, { turnId, controller, provider });

      const startedAt = new Date().toISOString();
      this.turnStore.create({
        id: turnId,
        requestId: turnId,
        sessionId,
        status: "running",
        source: request.source,
        startedAt,
      });
      this.sessionStore.update(sessionId, { status: "busy", lastTurnAt: startedAt });

      let result: BridgeTurnResult;
      try {
        result = await provider.runTurn(turnReq, {
          signal: controller.signal,
          emit: ctx.emit,
        });
      } catch (error) {
        const cancelled = controller.signal.aborted
          || (error instanceof DOMException && error.name === "AbortError");
        this.turnStore.update(turnId, {
          status: cancelled ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          errorCode: cancelled ? "client_cancelled" : "provider_exception",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      this.turnStore.update(turnId, {
        status: persistedStatus(result),
        completedAt: new Date().toISOString(),
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        usageJson: result.usage ? JSON.stringify(result.usage) : undefined,
      });

      if (result.status === "completed") {
        for (const message of currentMessages) {
          // Protocol adapters may inject turn-scoped instructions or control context that the
          // provider needs for this turn but must not become canonical session history.
          if (message.metadata?.transient === true) continue;
          this.messageStore.create({
            id: message.id,
            sessionId,
            role: message.role,
            contentJson: JSON.stringify(message.content),
            createdAt: message.createdAt,
            metadataJson: message.metadata ? JSON.stringify(message.metadata) : undefined,
          });
        }
        this.messageStore.create({
          id: `msg_${result.turnId}`,
          sessionId,
          role: "assistant",
          contentJson: JSON.stringify([{ type: "text", text: result.text }]),
          createdAt: new Date().toISOString(),
          metadataJson: result.providerMetadata ? JSON.stringify(result.providerMetadata) : undefined,
        });
      }

      return result;
    } finally {
      if (externalAbort && ctx.signal) ctx.signal.removeEventListener("abort", externalAbort);
      const active = this.activeTurns.get(sessionId);
      if (!turnId || active?.turnId === turnId) this.activeTurns.delete(sessionId);

      const latest = this.sessionStore.get(sessionId);
      if (latest?.status === "busy") this.sessionStore.update(sessionId, { status: "ready" });
      releaseCapacity?.();
      unlock?.();
      releaseAdmission();
    }
  }

  async cancel(idOrName: string, turnId: string = "latest"): Promise<boolean> {
    const session = await this.resolveSession(idOrName);
    if (session.status === "closed") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }

    const active = this.activeTurns.get(session.id);
    if (!active) return false;
    if (turnId !== "latest" && turnId !== active.turnId) {
      throw new BridgeError(
        "turn_not_active",
        `Turn ${turnId} is not the active turn for session ${session.id}`,
        false,
      );
    }

    const reason = new DOMException("Bridge turn cancelled", "AbortError");
    if (!active.controller.signal.aborted) active.controller.abort(reason);
    if (active.provider.cancelTurn) {
      await active.provider.cancelTurn(session.id, active.turnId).catch(() => undefined);
    }
    return true;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.activeTurns.entries()];
    await Promise.all(active.map(async ([sessionId, turn]) => {
      if (!turn.controller.signal.aborted) {
        turn.controller.abort(new DOMException("Bridge runtime is shutting down", "AbortError"));
      }
      if (turn.provider.cancelTurn) {
        await turn.provider.cancelTurn(sessionId, turn.turnId).catch(() => undefined);
      }
    }));

    const deadline = Date.now() + timeoutMs;
    while (this.admittedTurns > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.admittedTurns > 0) {
      throw new BridgeError(
        "shutdown_timeout",
        `${this.admittedTurns} bridge turn(s) did not settle before shutdown timeout`,
        false,
      );
    }
  }

  async close(idOrName: string): Promise<void> {
    const session = await this.resolveSession(idOrName);
    if (session.status === "closed") return;

    this.sessionStore.update(session.id, { status: "closing" });
    const active = this.activeTurns.get(session.id);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException("Bridge session closed", "AbortError"));
      if (active.provider.cancelTurn) {
        await active.provider.cancelTurn(session.id, active.turnId).catch(() => undefined);
      }
    }

    const unlock = await this.getLock(session.id).acquire();
    try {
      const provider = this.providerFor(session);
      if (provider.closeSession) await provider.closeSession(session.id);
      this.sessionStore.update(session.id, { status: "closed" });
      this.activeTurns.delete(session.id);
    } finally {
      unlock();
    }
  }

  recoverInterruptedTurns(): number {
    return this.turnStore.markInterruptedTurnsFailed();
  }
}
