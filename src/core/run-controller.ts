import type {
  CollaborationRun,
  ExternalAgentAdapter,
  AgentDecision,
  AgentTurnInput,
  BridgeMessage,
  ExternalAgentAdapterConfig,
  PriorCollaborationTurn,
} from "./domain";
import { generateId, generateRunId, generateCollaborationTurnId, generateCollaborationMessageId } from "./ids";
import type { RunStore } from "../persistence/run-store";
import type { AuditStore } from "../persistence/audit-store";
import type { SessionManager } from "./session-manager";
import { BridgeError } from "./errors";
import {
  type CollaborationConfig,
  type RoleBasedCollaborationRun,
  type CollaborationTurnRecord,
  type RoleBasedRunBudget,
  type RoleBasedCollaborationRunStatus,
  type ParticipantRecord,
  P4_DEFAULT_BUDGET,
} from "./collaboration-domain";
import type {
  PreparedRoleParticipants,
  ParticipantRuntime,
  RoleBasedExecutionResult,
  RoleBasedExecutionOptions,
} from "./collaboration-runtime";
import type { RoleBasedRunPersistence } from "./collaboration-persistence";
import { InMemoryRoleBasedRunPersistence } from "./collaboration-persistence";
import {
  type CollaborationMessageRecord,
  computeCollaborationMessageHash,
  assertMessageWithinSizeBound,
  normalizeCanonicalText,
} from "./collaboration-transcript";

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
  const transcript: NonNullable<AgentTurnInput["transcript"]> = [];
  for (const message of messages) {
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();
    if (!text) continue;
    if (message.role === "assistant") transcript.push({ speaker: "chatgpt", text });
    else if (message.role === "user") transcript.push({ speaker: "agent", text });
  }
  return transcript;
}

function retryableError(error: unknown): boolean {
  return error instanceof BridgeError ? error.retryable : false;
}

export class RunController {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly runSettlements = new Map<string, Promise<void>>();

  constructor(
    private readonly runStore: RunStore,
    private readonly sessionManager: SessionManager,
    private readonly auditStore: AuditStore,
    private readonly getAgentAdapter: (
      id: string,
      command?: string[],
      config?: ExternalAgentAdapterConfig,
    ) => ExternalAgentAdapter,
    private readonly rolePersistence?: RoleBasedRunPersistence,
  ) {}

  async startRun(
    sessionId: string,
    objective: string,
    agentAdapterId: string,
    command?: string[],
    budgetOverrides?: Partial<CollaborationRun["budget"]>,
    agentAdapterConfig?: ExternalAgentAdapterConfig,
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

    const settlement = this.runLoop(run, command, agentAdapterConfig, controller.signal)
      .catch(error => {
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
      })
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.runSettlements.delete(run.id);
      });
    this.runSettlements.set(run.id, settlement);
    void settlement;

    return run;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = this.runStore.get(runId);
    if (!run || run.status !== "running") return false;

    const controller = this.activeRuns.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException("Collaboration run cancelled", "AbortError"));
    }
    await this.sessionManager.cancel(run.sessionId, "latest").catch(() => false);

    const current = this.runStore.get(runId);
    if (current?.status === "running") {
      const completedAt = new Date().toISOString();
      this.runStore.update(runId, { status: "cancelled", completedAt });
      this.auditStore.log({
        eventType: "run.cancelled",
        runId,
        sessionId: run.sessionId,
        createdAt: completedAt,
      });
    }

    await this.runSettlements.get(runId)?.catch(() => undefined);
    return true;
  }

  async cancelAllRuns(): Promise<number> {
    const ids = [...this.activeRuns.keys()];
    const results = await Promise.all(ids.map(id => this.cancelRun(id)));
    await this.waitForIdle();
    return results.filter(Boolean).length;
  }

  async waitForIdle(): Promise<void> {
    while (this.runSettlements.size > 0) {
      await Promise.allSettled([...this.runSettlements.values()]);
    }
  }

  private async nextAgentDecision(
    adapter: ExternalAgentAdapter,
    input: AgentTurnInput,
    parentSignal: AbortSignal,
    remainingMs: number,
  ): Promise<AgentDecision> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
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
    agentAdapterConfig: ExternalAgentAdapterConfig | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let consecutiveFailures = 0;
    const adapter = this.getAgentAdapter(run.agentAdapterId, command, agentAdapterConfig);
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
        if (signal.aborted) chatController.abort(signal.reason);
        else signal.addEventListener("abort", onRunAbort, { once: true });
        const chatTimeout = setTimeout(
          () => chatController.abort(new DOMException("Collaboration run wall-clock budget exhausted", "TimeoutError")),
          Math.max(1, chatRemaining),
        );

        try {
          const session = await this.sessionManager.get(run.sessionId);
          const cwd = process.cwd();
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
              environment: { cwd, workspaceRoots: [cwd] },
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

  /**
   * Executes a bounded, sequential multi-participant role-based collaboration run (P4).
   *
   * Invariants:
   * 1. Strict sequential turns (maxParallelTurns = 1; active participant turns <= 1 at all times).
   * 2. Pure hub-and-spoke coordination through priorTurns context; no direct agent-to-agent meshes.
   * 3. Lazy participant initialization: initialize() called at most once per participant runtime.
   * 4. Persistent runtime reuse across rounds for loopMode "repeat_until_done".
   * 5. Strict terminal authority: only designated policy.terminalRoles can terminate with 'done'.
   * 6. Hard budget enforcement: maxTurns counts participant turns; maxWallClockMs marks timed_out.
   * 7. Deterministic cleanup: closes all initialized adapters in reverse initialization order in finally block.
   */
  async executeRoleBasedRun(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    options?: RoleBasedExecutionOptions,
  ): Promise<RoleBasedExecutionResult> {
    const session = await this.sessionManager.get(sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }

    const clock = options?.clock ?? (() => new Date().toISOString());
    const nowFn = options?.now ?? (() => Date.now());
    const turnIdFactory = options?.turnIdFactory ?? generateCollaborationTurnId;
    const runIdFactory = options?.runIdFactory ?? generateRunId;
    const messageIdFactory = options?.messageIdFactory ?? generateCollaborationMessageId;
    const persistence =
      options?.persistence ?? this.rolePersistence ?? new InMemoryRoleBasedRunPersistence();

    const runId = runIdFactory();
    const nowIso = clock();
    const startTimestamp = nowFn();

    const budget: RoleBasedRunBudget = {
      ...P4_DEFAULT_BUDGET,
      ...(config.budget ?? {}),
      maxParallelTurns: 1,
    };

    const plansByRoleId = new Map<string, (typeof prepared.plans)[number]>();
    for (const plan of prepared.plans) {
      plansByRoleId.set(plan.roleId, plan);
    }

    const runtimesByParticipantId = new Map<string, ParticipantRuntime>();
    for (const runtime of prepared.runtimes) {
      runtimesByParticipantId.set(runtime.participantId, runtime);
    }

    const participantsById: Record<string, ParticipantRecord> = { ...prepared.records.participantsById };
    const participantIds = [...prepared.records.participantIds];

    // Atomically persist initial run and participants before any external adapter initialize or turn execution
    const initialRun: RoleBasedCollaborationRun = {
      id: runId,
      sessionId,
      objective: config.objective,
      status: "running",
      round: 0,
      budget,
      policy: config.policy,
      participantIds,
      participantsById,
      turnHistory: [],
      createdAt: nowIso,
      startedAt: nowIso,
    };
    persistence.createInitialRun(initialRun, prepared.plans);

    const initializedParticipants = new Set<string>();
    const priorTurns: PriorCollaborationTurn[] = [];
    const turnHistory: string[] = [];
    const turns: CollaborationTurnRecord[] = [];
    let messageSequenceIndex = 0;
    let runStatus: RoleBasedCollaborationRunStatus = "running";
    let finalSummary: string | undefined = undefined;
    let round = 0;
    let turnIndex = 0;

    try {
      loop: while (runStatus === "running") {
        for (let seqIdx = 0; seqIdx < config.policy.roleSequence.length; seqIdx++) {
          // Check maxTurns budget before turn execution
          if (turnIndex >= budget.maxTurns) {
            runStatus = "budget_exhausted";
            finalSummary = `Exceeded maximum allowed turns (${budget.maxTurns})`;
            break loop;
          }

          // Check wall-clock deadline before turn execution
          const elapsed = nowFn() - startTimestamp;
          if (elapsed >= budget.maxWallClockMs) {
            runStatus = "timed_out";
            finalSummary = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
            break loop;
          }

          // Check cancellation signal before turn execution
          if (options?.signal?.aborted) {
            runStatus = "cancelled";
            finalSummary = "Collaboration run was cancelled";
            break loop;
          }

          const roleId = config.policy.roleSequence[seqIdx]!;
          const plan = plansByRoleId.get(roleId);
          if (!plan) {
            throw new BridgeError("invalid_request", `Missing plan for role '${roleId}'`, false);
          }
          const runtime = runtimesByParticipantId.get(plan.participantId);
          if (!runtime) {
            throw new BridgeError("invalid_request", `Missing runtime for participant '${plan.participantId}'`, false);
          }

          // Mark participant active
          participantsById[runtime.participantId] = {
            ...participantsById[runtime.participantId]!,
            status: "active",
            lastActiveAt: clock(),
          };

          // Lazy adapter initialization: at most once per participant runtime
          if (!initializedParticipants.has(runtime.participantId)) {
            try {
              await runtime.adapter.initialize?.({
                runId,
                objective: config.objective,
                cwd: plan.config.cwd ?? process.cwd(),
              });
              initializedParticipants.add(runtime.participantId);
            } catch (initErr) {
              const turnId = turnIdFactory();
              const turnTime = clock();
              const failedTurn: CollaborationTurnRecord = {
                id: turnId,
                runId,
                round,
                turnIndex,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                status: "failed",
                inputSummary: `Initialize participant ${runtime.participantId} for role ${runtime.roleId}`,
                error: {
                  code: initErr instanceof BridgeError ? initErr.code : "agent_adapter_failed",
                  message: initErr instanceof Error ? initErr.message : String(initErr),
                  retryable: retryableError(initErr),
                },
                startedAt: turnTime,
                completedAt: turnTime,
                durationMs: 0,
              };
              turns.push(failedTurn);
              turnHistory.push(turnId);

              const failedPart: ParticipantRecord = {
                ...participantsById[runtime.participantId]!,
                status: "failed",
                consecutiveFailures: (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1,
                lastActiveAt: turnTime,
              };
              participantsById[runtime.participantId] = failedPart;

              runStatus = "failed";
              finalSummary = initErr instanceof Error ? initErr.message : String(initErr);

              try {
                persistence.recordTurnTransaction({
                  turn: failedTurn,
                  participant: failedPart,
                  runUpdates: {
                    id: runId,
                    status: "failed",
                    finalSummary,
                    completedAt: turnTime,
                  },
                });
              } catch {
                // Best effort
              }
              break loop;
            }
          }

          const roleDef = plan.role;
          const input: AgentTurnInput = {
            runId,
            objective: config.objective,
            round,
            workspace: {
              cwd: plan.config.cwd ?? process.cwd(),
            },
            collaboration: {
              participantId: runtime.participantId,
              roleId: runtime.roleId,
              roleName: roleDef.name,
              systemInstructions: roleDef.systemInstructions,
              sequenceIndex: seqIdx,
              priorTurns: Object.freeze([...priorTurns]),
            },
          };

          const turnId = turnIdFactory();
          const turnStartedAt = clock();
          const turnStartMs = nowFn();
          const remainingMs = budget.maxWallClockMs - (turnStartMs - startTimestamp);

          if (remainingMs <= 0) {
            runStatus = "timed_out";
            finalSummary = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
            break loop;
          }

          let decision: AgentDecision;
          try {
            decision = await this.nextAgentDecision(
              runtime.adapter,
              input,
              options?.signal ?? new AbortController().signal,
              remainingMs,
            );
          } catch (turnErr) {
            const durationMs = nowFn() - turnStartMs;
            const isAborted = options?.signal?.aborted;
            const isTimeout =
              (turnErr instanceof DOMException && turnErr.name === "TimeoutError") ||
              nowFn() - startTimestamp >= budget.maxWallClockMs;

            const turnStatus = isAborted ? "cancelled" : "failed";
            const turnCompletedAt = clock();
            const failedTurn: CollaborationTurnRecord = {
              id: turnId,
              runId,
              round,
              turnIndex,
              participantId: runtime.participantId,
              roleId: runtime.roleId,
              status: turnStatus,
              inputSummary: `Turn for role ${runtime.roleId}`,
              error: {
                code: turnErr instanceof BridgeError ? turnErr.code : (isTimeout ? "agent_adapter_timeout" : "agent_adapter_failed"),
                message: turnErr instanceof Error ? turnErr.message : String(turnErr),
                retryable: retryableError(turnErr),
              },
              startedAt: turnStartedAt,
              completedAt: turnCompletedAt,
              durationMs,
            };
            turns.push(failedTurn);
            turnHistory.push(turnId);

            const failedPart: ParticipantRecord = {
              ...participantsById[runtime.participantId]!,
              status: "failed",
              consecutiveFailures: (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1,
              lastActiveAt: turnCompletedAt,
            };
            participantsById[runtime.participantId] = failedPart;

            if (isAborted) {
              runStatus = "cancelled";
              finalSummary = "Collaboration run was cancelled";
            } else if (isTimeout) {
              runStatus = "timed_out";
              finalSummary = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
            } else {
              runStatus = "failed";
              finalSummary = turnErr instanceof Error ? turnErr.message : String(turnErr);
            }

            try {
              persistence.recordTurnTransaction({
                turn: failedTurn,
                participant: failedPart,
                runUpdates: {
                  id: runId,
                  status: runStatus,
                  finalSummary,
                  completedAt: turnCompletedAt,
                },
              });
            } catch {
              // Best effort
            }
            break loop;
          }

          // Successful turn execution
          const durationMs = nowFn() - turnStartMs;
          const turnCompletedAt = clock();

          let rawContent: string | undefined = undefined;
          if (decision.type === "message") {
            rawContent = decision.content;
          } else if (decision.type === "done") {
            rawContent = decision.summary;
          } else if (decision.type === "pause") {
            rawContent = decision.reason;
          } else if (decision.type === "error") {
            rawContent = decision.message;
          }

          let messageRecord: CollaborationMessageRecord | undefined = undefined;
          if (rawContent !== undefined) {
            const normalized = normalizeCanonicalText(rawContent);
            assertMessageWithinSizeBound(normalized);
            const contentHash = computeCollaborationMessageHash({
              runId,
              turnId,
              participantId: runtime.participantId,
              roleId: runtime.roleId,
              decisionType: decision.type,
              content: normalized,
            });
            messageRecord = {
              id: messageIdFactory(),
              runId,
              turnId,
              sequenceIndex: messageSequenceIndex,
              senderParticipantId: runtime.participantId,
              senderRoleId: runtime.roleId,
              decisionType: decision.type,
              content: normalized,
              contentHash,
              createdAt: turnCompletedAt,
            };
          }

          const isTerminalRole =
            decision.type === "done" && config.policy.terminalRoles.includes(runtime.roleId);
          let nextRunStatus: RoleBasedCollaborationRunStatus = runStatus;
          let nextFinalSummary: string | undefined = finalSummary;
          let nextCompletedAt: string | undefined = undefined;

          if (decision.type === "done" && isTerminalRole) {
            nextRunStatus = "completed";
            nextFinalSummary = decision.summary;
            nextCompletedAt = turnCompletedAt;
          } else if (decision.type === "pause") {
            nextRunStatus = "paused";
            nextFinalSummary = decision.reason;
            nextCompletedAt = turnCompletedAt;
          } else if (decision.type === "error") {
            nextRunStatus = "failed";
            nextFinalSummary = decision.message;
            nextCompletedAt = turnCompletedAt;
          }

          const turnRecord: CollaborationTurnRecord = {
            id: turnId,
            runId,
            round,
            turnIndex,
            participantId: runtime.participantId,
            roleId: runtime.roleId,
            status: "completed",
            inputSummary: `Turn for role ${runtime.roleId}`,
            decision,
            startedAt: turnStartedAt,
            completedAt: turnCompletedAt,
            durationMs,
          };

          const participantUpdate: ParticipantRecord = {
            ...participantsById[runtime.participantId]!,
            status: "idle",
            turnsExecuted: (participantsById[runtime.participantId]?.turnsExecuted ?? 0) + 1,
            consecutiveFailures: 0,
            lastActiveAt: turnCompletedAt,
          };

          try {
            persistence.recordTurnTransaction({
              turn: turnRecord,
              message: messageRecord,
              participant: participantUpdate,
              runUpdates: {
                id: runId,
                status: nextRunStatus,
                round,
                activeParticipantId: undefined,
                finalSummary: nextFinalSummary,
                completedAt: nextCompletedAt,
              },
            });
          } catch (persistErr) {
            // Prompt Section 54: Persistence failure must stop orchestration immediately!
            // Do NOT relay uncommitted turn to the next participant!
            runStatus = "failed";
            finalSummary = persistErr instanceof Error ? persistErr.message : String(persistErr);
            break loop;
          }

          // Persistence succeeded: commit in-memory tracking
          if (messageRecord) {
            messageSequenceIndex += 1;
          }
          turnIndex += 1;
          turns.push(turnRecord);
          turnHistory.push(turnId);
          participantsById[runtime.participantId] = participantUpdate;

          // Decision processing
          if (decision.type === "message") {
            priorTurns.push({
              participantId: runtime.participantId,
              roleId: runtime.roleId,
              decisionType: "message",
              text: messageRecord!.content,
            });
          } else if (decision.type === "done") {
            priorTurns.push({
              participantId: runtime.participantId,
              roleId: runtime.roleId,
              decisionType: "done",
              text: messageRecord!.content,
            });
            if (isTerminalRole) {
              runStatus = "completed";
              finalSummary = decision.summary;
              break loop;
            }
            // Non-terminal role finished its subtask; workflow continues!
          } else if (decision.type === "pause") {
            runStatus = "paused";
            finalSummary = decision.reason;
            break loop;
          } else if (decision.type === "error") {
            runStatus = "failed";
            finalSummary = decision.message;
            break loop;
          }
        }

        // End of sequence pass
        if (runStatus === "running") {
          if (config.policy.loopMode === "once") {
            runStatus = "completed";
            finalSummary = finalSummary ?? "Role sequence completed.";
            break loop;
          } else if (config.policy.loopMode === "repeat_until_done") {
            round += 1;
          }
        }
      }
    } finally {
      // Deterministic cleanup: close initialized adapters in reverse initialization order,
      // followed by any remaining prepared adapters (at most once per adapter)
      const closed = new Set<string>();
      const initializedReverse = [...initializedParticipants].reverse();
      for (const partId of initializedReverse) {
        closed.add(partId);
        const runtime = runtimesByParticipantId.get(partId);
        try {
          await runtime?.adapter.close?.();
        } catch {
          // Ignore secondary close errors to preserve run result
        }
      }
      for (const runtime of prepared.runtimes) {
        if (!closed.has(runtime.participantId)) {
          closed.add(runtime.participantId);
          try {
            await runtime.adapter.close?.();
          } catch {
            // Ignore secondary close errors to preserve run result
          }
        }
      }
    }

    const completedAt = clock();
    try {
      persistence.finalizeRun(runId, {
        status: runStatus,
        round,
        finalSummary,
        completedAt,
      });
    } catch {
      // Best effort finalization
    }

    const roleBasedRun: RoleBasedCollaborationRun = {
      id: runId,
      sessionId,
      objective: config.objective,
      status: runStatus,
      round,
      budget,
      policy: config.policy,
      participantIds,
      participantsById,
      activeParticipantId: undefined,
      turnHistory,
      createdAt: nowIso,
      startedAt: nowIso,
      completedAt,
      finalSummary,
    };

    return {
      run: roleBasedRun,
      turns,
    };
  }

  getRun(runId: string): CollaborationRun | null {
    return this.runStore.get(runId);
  }
}
