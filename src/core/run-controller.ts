import type {
  CollaborationRun,
  ExternalAgentAdapter,
  AgentDecision,
  AgentTurnInput,
  BridgeMessage,
} from "./domain";
import { generateId, generateRunId } from "./ids";
import type { RunStore } from "../persistence/run-store";
import type { AuditStore } from "../persistence/audit-store";
import type { SessionManager } from "./session-manager";
import { BridgeError } from "./errors";

const HARD_MAX_ROUNDS = 100;
const DEFAULT_BUDGET: CollaborationRun["budget"] = {
  maxRounds: 20,
  maxWallClockMs: 3_600_000,
  maxConsecutiveFailures: 3,
};

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BridgeError("invalid_request", `${name} must be a positive finite number`, false);
  }
  return value;
}

function agentTranscript(messages: BridgeMessage[]): AgentTurnInput["transcript"] {
  return messages.flatMap(message => {
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();
    if (!text) return [];
    if (message.role === "assistant") return [{ speaker: "chatgpt" as const, text }];
    if (message.role === "user") return [{ speaker: "agent" as const, text }];
    return [];
  });
}

function retryableError(error: unknown): boolean {
  return error instanceof BridgeError ? error.retryable : false;
}

export class RunController {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly runStore: RunStore,
    private readonly sessionManager: SessionManager,
    private readonly auditStore: AuditStore,
    private readonly getAgentAdapter: (id: string, command?: string[]) => ExternalAgentAdapter,
  ) {}

  async startRun(
    sessionId: string,
    objective: string,
    agentAdapterId: string,
    command?: string[],
    budgetOverrides?: Partial<CollaborationRun["budget"]>,
  ): Promise<CollaborationRun> {
    const session = await this.sessionManager.get(sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }

    const budget: CollaborationRun["budget"] = {
      maxRounds: positiveFinite("maxRounds", budgetOverrides?.maxRounds ?? DEFAULT_BUDGET.maxRounds),
      maxWallClockMs: positiveFinite(
        "maxWallClockMs",
        budgetOverrides?.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs,
      ),
      maxConsecutiveFailures: positiveFinite(
        "maxConsecutiveFailures",
        budgetOverrides?.maxConsecutiveFailures ?? DEFAULT_BUDGET.maxConsecutiveFailures,
      ),
    };
    if (!Number.isInteger(budget.maxRounds) || budget.maxRounds > HARD_MAX_ROUNDS) {
      throw new BridgeError(
        "invalid_request",
        `maxRounds must be an integer between 1 and ${HARD_MAX_ROUNDS}`,
        false,
      );
    }
    if (!Number.isInteger(budget.maxConsecutiveFailures)) {
      throw new BridgeError("invalid_request", "maxConsecutiveFailures must be an integer", false);
    }

    const now = new Date().toISOString();
    const run: CollaborationRun = {
      id: generateRunId(),
      sessionId: session.id,
      agentAdapterId,
      objective,
      status: "running",
      round: 0,
      budget,
      createdAt: now,
      startedAt: now,
    };

    this.runStore.create(run);
    this.auditStore.log({
      eventType: "run.start",
      runId: run.id,
      sessionId: run.sessionId,
      payload: { objective, agentAdapterId, budget },
      createdAt: now,
    });

    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);

    void this.runLoop(run, command, controller.signal).catch(error => {
      const current = this.runStore.get(run.id);
      if (current && current.status === "running") {
        const completedAt = new Date().toISOString();
        this.runStore.update(run.id, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          completedAt,
          finalSummary: error instanceof Error ? error.message : String(error),
        });
        this.auditStore.log({
          eventType: controller.signal.aborted ? "run.cancelled" : "run.failed",
          runId: run.id,
          sessionId: run.sessionId,
          payload: { error: error instanceof Error ? error.message : String(error) },
          createdAt: completedAt,
        });
      }
      this.activeRuns.delete(run.id);
    });

    return run;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = this.runStore.get(runId);
    if (!run) return false;
    if (run.status !== "running") return false;

    const controller = this.activeRuns.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException("Collaboration run cancelled", "AbortError"));
    }
    // SessionManager links this same run signal into the browser adapter, but targeted cancellation
    // shortens teardown when a provider also exposes an explicit cancel hook.
    await this.sessionManager.cancel(run.sessionId, "latest").catch(() => false);

    const completedAt = new Date().toISOString();
    this.runStore.update(runId, { status: "cancelled", completedAt });
    this.auditStore.log({
      eventType: "run.cancelled",
      runId,
      sessionId: run.sessionId,
      createdAt: completedAt,
    });
    return true;
  }

  private async nextAgentDecision(
    adapter: ExternalAgentAdapter,
    input: AgentTurnInput,
    parentSignal: AbortSignal,
    remainingMs: number,
  ): Promise<AgentDecision> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Collaboration run wall-clock budget exhausted", "TimeoutError")),
      Math.max(1, remainingMs),
    );
    try {
      return await adapter.next(input, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  private remaining(startTime: number, run: CollaborationRun): number {
    return run.budget.maxWallClockMs - (Date.now() - startTime);
  }

  private markBudgetExhausted(run: CollaborationRun, reason: string): void {
    const completedAt = new Date().toISOString();
    this.runStore.update(run.id, {
      status: "budget_exhausted",
      completedAt,
      finalSummary: reason,
    });
    this.auditStore.log({
      eventType: "run.budget_exhausted",
      runId: run.id,
      sessionId: run.sessionId,
      payload: { round: run.round, reason },
      createdAt: completedAt,
    });
  }

  private async runLoop(
    run: CollaborationRun,
    command: string[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let consecutiveFailures = 0;
    const adapter = this.getAgentAdapter(run.agentAdapterId, command);
    const startTime = Date.now();
    let lastChatGptResponse: AgentTurnInput["lastChatGptResponse"];

    try {
      await adapter.initialize?.({
        runId: run.id,
        objective: run.objective,
        cwd: process.cwd(),
      });

      while (true) {
        if (signal.aborted) return;

        if (run.round >= run.budget.maxRounds) {
          this.markBudgetExhausted(run, `Maximum rounds (${run.budget.maxRounds}) reached`);
          return;
        }

        const remainingMs = this.remaining(startTime, run);
        if (remainingMs <= 0) {
          this.markBudgetExhausted(run, "Wall-clock budget exhausted");
          return;
        }

        const transcript = await this.sessionManager.transcript(run.sessionId);
        const input: AgentTurnInput = {
          runId: run.id,
          objective: run.objective,
          round: run.round,
          lastChatGptResponse,
          transcript: agentTranscript(transcript),
          workspace: { cwd: process.cwd() },
        };

        let decision: AgentDecision;
        try {
          decision = await this.nextAgentDecision(adapter, input, signal, remainingMs);
        } catch (error) {
          if (signal.aborted) return;
          if (this.remaining(startTime, run) <= 0) {
            this.markBudgetExhausted(run, "Wall-clock budget exhausted during external-agent turn");
            return;
          }
          decision = {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            retryable: retryableError(error),
          };
        }

        if (decision.type === "error") {
          consecutiveFailures += 1;
          if (!decision.retryable || consecutiveFailures >= run.budget.maxConsecutiveFailures) {
            const completedAt = new Date().toISOString();
            this.runStore.update(run.id, {
              status: "failed",
              completedAt,
              finalSummary: decision.message,
            });
            this.auditStore.log({
              eventType: "run.failed",
              runId: run.id,
              sessionId: run.sessionId,
              payload: { round: run.round, error: decision.message },
              createdAt: completedAt,
            });
            return;
          }
          continue;
        }

        if (decision.type === "done") {
          const completedAt = new Date().toISOString();
          this.runStore.update(run.id, {
            status: "completed",
            completedAt,
            finalSummary: decision.summary,
          });
          this.auditStore.log({
            eventType: "run.completed",
            runId: run.id,
            sessionId: run.sessionId,
            payload: { round: run.round, summary: decision.summary },
            createdAt: completedAt,
          });
          return;
        }

        if (decision.type === "pause") {
          this.runStore.update(run.id, { status: "paused", finalSummary: decision.reason });
          this.auditStore.log({
            eventType: "run.paused",
            runId: run.id,
            sessionId: run.sessionId,
            payload: { round: run.round, reason: decision.reason },
            createdAt: new Date().toISOString(),
          });
          return;
        }

        this.auditStore.log({
          eventType: "run.agent_message",
          runId: run.id,
          sessionId: run.sessionId,
          payload: { round: run.round, content: decision.content },
          createdAt: new Date().toISOString(),
        });

        const chatRemaining = this.remaining(startTime, run);
        if (chatRemaining <= 0) {
          this.markBudgetExhausted(run, "Wall-clock budget exhausted before ChatGPT turn");
          return;
        }

        const chatController = new AbortController();
        const onRunAbort = () => chatController.abort(signal.reason);
        signal.addEventListener("abort", onRunAbort, { once: true });
        const chatTimeout = setTimeout(
          () => chatController.abort(new DOMException("Collaboration run wall-clock budget exhausted", "TimeoutError")),
          Math.max(1, chatRemaining),
        );

        try {
          const session = await this.sessionManager.get(run.sessionId);
          const chatgptResult = await this.sessionManager.send(
            run.sessionId,
            {
              source: "relay",
              model: {
                provider: session.provider,
                model: session.model,
                effort: session.effort,
              },
              messages: [{
                id: generateId("msg"),
                role: "user",
                content: [
                  { type: "text", text: decision.content },
                  ...(decision.attachments ?? []),
                ],
                createdAt: new Date().toISOString(),
              }],
              stream: false,
            },
            { signal: chatController.signal, emit: () => undefined },
          );

          if (chatgptResult.status !== "completed") {
            consecutiveFailures += 1;
            if (consecutiveFailures >= run.budget.maxConsecutiveFailures || chatgptResult.error?.retryable !== true) {
              const completedAt = new Date().toISOString();
              this.runStore.update(run.id, {
                status: chatController.signal.aborted && this.remaining(startTime, run) <= 0
                  ? "budget_exhausted"
                  : "failed",
                completedAt,
                finalSummary: chatgptResult.error?.message || `ChatGPT turn ended ${chatgptResult.status}`,
              });
              return;
            }
            continue;
          }

          consecutiveFailures = 0;
          lastChatGptResponse = {
            text: chatgptResult.text,
            structured: chatgptResult.structured,
          };
          this.auditStore.log({
            eventType: "run.chatgpt_message",
            runId: run.id,
            sessionId: run.sessionId,
            turnId: chatgptResult.turnId,
            payload: { round: run.round, text: chatgptResult.text },
            createdAt: new Date().toISOString(),
          });

          run.round += 1;
          this.runStore.update(run.id, { round: run.round });
        } catch (error) {
          if (signal.aborted) return;
          if (this.remaining(startTime, run) <= 0) {
            this.markBudgetExhausted(run, "Wall-clock budget exhausted during ChatGPT turn");
            return;
          }
          consecutiveFailures += 1;
          if (!retryableError(error) || consecutiveFailures >= run.budget.maxConsecutiveFailures) {
            const completedAt = new Date().toISOString();
            this.runStore.update(run.id, {
              status: "failed",
              completedAt,
              finalSummary: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        } finally {
          clearTimeout(chatTimeout);
          signal.removeEventListener("abort", onRunAbort);
        }
      }
    } finally {
      await adapter.close?.().catch(() => undefined);
      this.activeRuns.delete(run.id);
      if (signal.aborted) {
        const current = this.runStore.get(run.id);
        if (current?.status === "running") {
          const completedAt = new Date().toISOString();
          this.runStore.update(run.id, { status: "cancelled", completedAt });
          this.auditStore.log({
            eventType: "run.cancelled",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: completedAt,
          });
        }
      }
    }
  }

  getRun(runId: string): CollaborationRun | null {
    return this.runStore.get(runId);
  }
}
