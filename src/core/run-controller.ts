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
  type RoleBasedRunPatch,
  isRoleBasedRunTerminalStatus,
  P4_DEFAULT_BUDGET,
} from "./collaboration-domain";
import type {
  PreparedRoleParticipants,
  ParticipantRuntime,
  RoleBasedExecutionResult,
  RoleBasedExecutionOptions,
  ActiveRoleRunControl,
} from "./collaboration-runtime";
import type { RoleBasedRunPersistence } from "./collaboration-persistence";
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
  if (error instanceof BridgeError) return error.retryable;
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return false;
}

export class RunController {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly runSettlements = new Map<string, Promise<void>>();
  private readonly activeRoleRuns = new Map<string, ActiveRoleRunControl>();
  private readonly roleRunSettlements = new Map<string, Promise<RoleBasedExecutionResult>>();

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
    const roleCount = await this.cancelAllRoleBasedRuns();
    await this.waitForIdle();
    return results.filter(Boolean).length + roleCount;
  }

  async waitForIdle(): Promise<void> {
    while (this.runSettlements.size > 0 || this.roleRunSettlements.size > 0) {
      await Promise.allSettled([
        ...this.runSettlements.values(),
        ...this.roleRunSettlements.values(),
      ]);
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
  private requireRolePersistence(): RoleBasedRunPersistence {
    if (!this.rolePersistence) {
      throw new BridgeError(
        "role_persistence_unavailable",
        "Role-based collaboration requires persistence to be configured on RunController",
        false,
      );
    }
    return this.rolePersistence;
  }

  /**
   * Starts an addressable role-based collaboration run asynchronously (P4).
   * Atomically persists initial run and participants, registers control,
   * launches execution loop in background, and returns the initial run record.
   */
  async startRoleBasedRun(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    options?: RoleBasedExecutionOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const session = await this.sessionManager.get(sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }

    const clock = options?.clock ?? (() => new Date().toISOString());
    const runIdFactory = options?.runIdFactory ?? generateRunId;
    const persistence = this.requireRolePersistence();

    const runId = runIdFactory();
    const nowIso = clock();

    const budget: RoleBasedRunBudget = {
      ...P4_DEFAULT_BUDGET,
      ...(config.budget ?? {}),
      maxParallelTurns: 1,
    };

    const participantsById: Record<string, ParticipantRecord> = { ...prepared.records.participantsById };
    const participantIds = [...prepared.records.participantIds];

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

    try {
      persistence.createInitialRun(initialRun, prepared.plans);
    } catch (persistErr) {
      if (persistErr instanceof BridgeError && persistErr.code === "collaboration_persistence_failed") {
        throw persistErr;
      }
      throw new BridgeError(
        "collaboration_persistence_failed",
        `Failed to persist initial role-based run: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        false,
      );
    }

    const rootAbortController = new AbortController();
    const onSignalAbort = () => {
      if (options?.signal) {
        rootAbortController.abort(options.signal.reason);
      }
    };
    if (options?.signal?.aborted) {
      rootAbortController.abort(options.signal.reason);
    } else if (options?.signal) {
      options.signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const control: ActiveRoleRunControl = {
      runId,
      rootAbortController,
      persistence,
      cancelledParticipantIds: new Set<string>(),
    };
    this.activeRoleRuns.set(runId, control);

    const settlement = this.executeRoleBasedLoop(
      runId,
      sessionId,
      config,
      prepared,
      control,
      options,
      initialRun,
    )
      .catch((error) => {
        const run = persistence.getRun(runId);
        const finalStatus: RoleBasedCollaborationRunStatus = control.rootAbortController.signal.aborted
          ? "cancelled"
          : "failed";
        const completedAt = clock();
        const finalSummary = error instanceof Error ? error.message : String(error);
        if (run && !isRoleBasedRunTerminalStatus(run.status)) {
          try {
            persistence.finalizeRun(runId, {
              status: finalStatus,
              finalSummary,
              completedAt,
              activeParticipantId: null,
            });
          } catch {
            // Guard against unhandled rejections if persistence failed
          }
        }
        let finalTurns: CollaborationTurnRecord[] = [];
        try {
          if (typeof persistence.getTurns === "function") {
            finalTurns = persistence.getTurns(runId);
          }
        } catch {
          finalTurns = [];
        }
        const result: RoleBasedExecutionResult = {
          run: {
            ...initialRun,
            status: finalStatus,
            finalSummary,
            completedAt,
          },
          turns: finalTurns,
        };
        return result;
      })
      .finally(() => {
        if (options?.signal) {
          options.signal.removeEventListener("abort", onSignalAbort);
        }
        this.activeRoleRuns.delete(runId);
        this.roleRunSettlements.delete(runId);
      });

    this.roleRunSettlements.set(runId, settlement);
    return initialRun;
  }

  /**
   * Executes a bounded, sequential multi-participant role-based collaboration run (P4).
   * Delegates to startRoleBasedRun and awaits settlement via waitForRoleBasedRun.
   */
  async executeRoleBasedRun(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    options?: RoleBasedExecutionOptions,
  ): Promise<RoleBasedExecutionResult> {
    const run = await this.startRoleBasedRun(sessionId, config, prepared, options);
    return await this.waitForRoleBasedRun(run.id);
  }

  /**
   * Waits for an active role-based collaboration run to settle.
   * Reconstructs settled run and turns from durable persistence.
   */
  async waitForRoleBasedRun(runId: string): Promise<RoleBasedExecutionResult> {
    const settlement = this.roleRunSettlements.get(runId);
    if (settlement) {
      return await settlement;
    }
    const persistence = this.requireRolePersistence();
    const run = persistence.getRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `Role-based run ${runId} not found`, false);
    }
    const turns = persistence.getTurns(runId);
    return { run, turns };
  }

  /**
   * Retrieves a role-based collaboration run by ID.
   */
  getRoleBasedRun(runId: string): RoleBasedCollaborationRun | null {
    const control = this.activeRoleRuns.get(runId);
    if (control) {
      return control.persistence.getRun(runId);
    }
    return this.rolePersistence?.getRun(runId) ?? null;
  }

  /**
   * Cancels an active role-based collaboration run.
   * Strictly avoids calling sessionManager.cancel() as role runs have no ChatGPT web turns.
   */
  async cancelRoleBasedRun(
    runId: string,
    reason = "Collaboration run was cancelled",
  ): Promise<boolean> {
    const control = this.activeRoleRuns.get(runId);
    if (!control) {
      const existing = this.getRoleBasedRun(runId);
      if (!existing || isRoleBasedRunTerminalStatus(existing.status) || existing.status !== "running") {
        return false;
      }
      try {
        this.requireRolePersistence().finalizeRun(runId, {
          status: "cancelled",
          finalSummary: reason,
          completedAt: new Date().toISOString(),
          activeParticipantId: null,
        });
      } catch (persistErr) {
        throw new BridgeError(
          "collaboration_persistence_failed",
          `Failed to persist run cancellation: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          false,
        );
      }
      return true;
    }

    const currentBefore = control.persistence.getRun(runId);
    if (currentBefore && isRoleBasedRunTerminalStatus(currentBefore.status)) {
      return false;
    }

    if (!control.rootAbortController.signal.aborted) {
      control.rootAbortController.abort(
        new DOMException(reason, "AbortError"),
      );
    }
    if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
      control.activeTurnController.abort(
        new DOMException(reason, "AbortError"),
      );
    }

    await this.roleRunSettlements.get(runId)?.catch(() => undefined);

    const current = control.persistence.getRun(runId);
    if (current && current.status === "running") {
      try {
        control.persistence.finalizeRun(runId, {
          status: "cancelled",
          finalSummary: reason,
          completedAt: new Date().toISOString(),
          activeParticipantId: null,
        });
      } catch (persistErr) {
        throw new BridgeError(
          "collaboration_persistence_failed",
          `Failed to persist run cancellation: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          false,
        );
      }
    }

    return true;
  }

  /**
   * Cancels a specific participant within an active role-based collaboration run.
   * Validates run ownership; aborts active turn if participant is active, or marks run failed if idle.
   * Fail-closed for required workflow; does not retry.
   */
  async cancelRoleParticipant(
    runId: string,
    participantId: string,
    reason = "Participant was cancelled",
  ): Promise<boolean> {
    const control = this.activeRoleRuns.get(runId);
    const run = control ? control.persistence.getRun(runId) : this.getRoleBasedRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `Role-based run ${runId} not found`, false);
    }
    if (!run.participantIds.includes(participantId)) {
      throw new BridgeError(
        "invalid_request",
        `Participant '${participantId}' does not belong to run '${runId}'`,
        false,
      );
    }

    if (isRoleBasedRunTerminalStatus(run.status) || run.status !== "running" || !control) {
      return false;
    }

    if (control.cancelledParticipantIds.has(participantId)) {
      return false;
    }

    control.cancelledParticipantIds.add(participantId);

    const nowIso = new Date().toISOString();
    const currentPart = run.participantsById[participantId];

    if (control.activeParticipantId === participantId) {
      // Target is active: turn controller abort and root abort will let executeRoleBasedLoop
      // atomically persist turn cancellation, participant cancellation, and run failure together.
      if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
        control.activeTurnController.abort(
          new DOMException(reason, "AbortError"),
        );
      }
      if (!control.rootAbortController.signal.aborted) {
        control.rootAbortController.abort(
          new DOMException(
            `Required role participant '${participantId}' was cancelled; required workflow failed`,
            "AbortError",
          ),
        );
      }
    } else {
      // Non-active target (idle or pending): atomically mark target participant cancelled and run failed.
      if (currentPart && currentPart.status !== "cancelled") {
        const cancelledPart: ParticipantRecord = {
          ...currentPart,
          status: "cancelled",
          lastActiveAt: nowIso,
        };
        try {
          control.persistence.updateParticipantAndRunTransaction({
            participant: cancelledPart,
            runUpdates: {
              id: runId,
              status: "failed",
              activeParticipantId: null,
              finalSummary: `Required role participant '${participantId}' was cancelled; required workflow failed`,
              completedAt: nowIso,
            },
          });
        } catch (persistErr) {
          throw new BridgeError(
            "collaboration_persistence_failed",
            `Failed to persist participant cancellation: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            false,
          );
        }
      }

      if (!control.rootAbortController.signal.aborted) {
        control.rootAbortController.abort(
          new DOMException(
            `Required role participant '${participantId}' was cancelled; required workflow failed`,
            "AbortError",
          ),
        );
      }
      if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
        control.activeTurnController.abort(
          new DOMException(
            `Required role participant '${participantId}' was cancelled; required workflow failed`,
            "AbortError",
          ),
        );
      }
    }

    await this.roleRunSettlements.get(runId)?.catch(() => undefined);
    return true;
  }

  /**
   * Cancels all active role-based collaboration runs.
   */
  async cancelAllRoleBasedRuns(): Promise<number> {
    const ids = [...this.activeRoleRuns.keys()];
    const results = await Promise.all(ids.map(id => this.cancelRoleBasedRun(id)));
    return results.filter(Boolean).length;
  }

  private async executeRoleBasedLoop(
    runId: string,
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    control: ActiveRoleRunControl,
    options: RoleBasedExecutionOptions | undefined,
    initialRun: RoleBasedCollaborationRun,
  ): Promise<RoleBasedExecutionResult> {
    const clock = options?.clock ?? (() => new Date().toISOString());
    const nowFn = options?.now ?? (() => Date.now());
    const turnIdFactory = options?.turnIdFactory ?? generateCollaborationTurnId;
    const messageIdFactory = options?.messageIdFactory ?? generateCollaborationMessageId;
    const persistence = control.persistence;

    const startTimestamp = nowFn();
    const budget = initialRun.budget;

    const plansByRoleId = new Map<string, (typeof prepared.plans)[number]>();
    for (const plan of prepared.plans) {
      plansByRoleId.set(plan.roleId, plan);
    }

    const runtimesByParticipantId = new Map<string, ParticipantRuntime>();
    for (const runtime of prepared.runtimes) {
      runtimesByParticipantId.set(runtime.participantId, runtime);
    }

    const participantsById: Record<string, ParticipantRecord> = { ...initialRun.participantsById };
    const participantIds = [...initialRun.participantIds];

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
          const roleId = config.policy.roleSequence[seqIdx]!;
          const plan = plansByRoleId.get(roleId);
          if (!plan) {
            throw new BridgeError("invalid_request", `Missing plan for role '${roleId}'`, false);
          }
          const runtime = runtimesByParticipantId.get(plan.participantId);
          if (!runtime) {
            throw new BridgeError("invalid_request", `Missing runtime for participant '${plan.participantId}'`, false);
          }

          let attemptInRole = 0;
          const maxRetries = budget.maxRetriesPerParticipant ?? P4_DEFAULT_BUDGET.maxRetriesPerParticipant;

          roleAttemptLoop: while (true) {
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
            if (control.cancelledParticipantIds.size > 0) {
              runStatus = "failed";
              finalSummary = `Required role participant '${[...control.cancelledParticipantIds].join(", ")}' was cancelled; required workflow failed`;
              break loop;
            }
            if (control.rootAbortController.signal.aborted) {
              runStatus = "cancelled";
              finalSummary = "Collaboration run was cancelled";
              break loop;
            }

            // Mark participant active and persist activeParticipantId
            const activeParticipant: ParticipantRecord = {
              ...participantsById[runtime.participantId]!,
              status: "active",
              lastActiveAt: clock(),
            };

            try {
              persistence.updateParticipantAndRunTransaction({
                participant: activeParticipant,
                runUpdates: {
                  id: runId,
                  activeParticipantId: runtime.participantId,
                },
              });
            } catch (persistErr) {
              throw new BridgeError(
                "collaboration_persistence_failed",
                `Failed to persist active participant transition: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                false,
              );
            }
            participantsById[runtime.participantId] = activeParticipant;
            control.activeParticipantId = runtime.participantId;

            // Lazy adapter initialization
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
                const isRetryable = retryableError(initErr);
                const canRetry =
                  isRetryable &&
                  attemptInRole < maxRetries &&
                  turnIndex + 1 < budget.maxTurns &&
                  nowFn() - startTimestamp < budget.maxWallClockMs &&
                  !control.rootAbortController.signal.aborted &&
                  control.cancelledParticipantIds.size === 0;

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
                    retryable: isRetryable,
                  },
                  startedAt: turnTime,
                  completedAt: turnTime,
                  durationMs: 0,
                };

                const consecutiveFailures = (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1;
                const failedPart: ParticipantRecord = {
                  ...participantsById[runtime.participantId]!,
                  status: canRetry ? "idle" : "failed",
                  consecutiveFailures,
                  lastActiveAt: turnTime,
                };

                const runStatusUpdate = canRetry ? "running" : "failed";
                const runSummaryUpdate = canRetry ? null : (initErr instanceof Error ? initErr.message : String(initErr));

                try {
                  persistence.recordTurnTransaction({
                    turn: failedTurn,
                    participant: failedPart,
                    runUpdates: {
                      id: runId,
                      status: runStatusUpdate,
                      activeParticipantId: null,
                      finalSummary: runSummaryUpdate,
                      completedAt: canRetry ? null : turnTime,
                    },
                  });
                } catch (persistErr) {
                  throw new BridgeError(
                    "collaboration_persistence_failed",
                    `Failed to persist failed initialization turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                    false,
                  );
                }

                turns.push(failedTurn);
                turnHistory.push(turnId);
                participantsById[runtime.participantId] = failedPart;
                turnIndex += 1;
                control.activeParticipantId = undefined;

                if (canRetry) {
                  attemptInRole += 1;
                  await runtime.adapter.close?.().catch(() => undefined);
                  if (runtime.recreateAdapter) {
                    runtime.adapter = runtime.recreateAdapter();
                  }
                  continue roleAttemptLoop;
                }

                runStatus = "failed";
                finalSummary = initErr instanceof Error ? initErr.message : String(initErr);
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
              control.activeParticipantId = undefined;
              break loop;
            }

            // Create turn-scoped abort controller linked to root
            const turnAbortController = new AbortController();
            control.activeTurnController = turnAbortController;
            const onRootAbort = () => {
              turnAbortController.abort(control.rootAbortController.signal.reason);
            };
            if (control.rootAbortController.signal.aborted) {
              turnAbortController.abort(control.rootAbortController.signal.reason);
            } else {
              control.rootAbortController.signal.addEventListener("abort", onRootAbort, { once: true });
            }

            let decision: AgentDecision;
            try {
              decision = await this.nextAgentDecision(
                runtime.adapter,
                input,
                turnAbortController.signal,
                remainingMs,
              );
            } catch (turnErr) {
              const durationMs = nowFn() - turnStartMs;
              const turnCompletedAt = clock();
              const isTargetCancelled = control.cancelledParticipantIds.has(runtime.participantId);
              const isOtherCancelled = control.cancelledParticipantIds.size > 0 && !isTargetCancelled;
              const isRunCancelled = control.rootAbortController.signal.aborted && control.cancelledParticipantIds.size === 0;
              const isTimeout =
                (turnErr instanceof DOMException && turnErr.name === "TimeoutError") ||
                nowFn() - startTimestamp >= budget.maxWallClockMs;

              control.activeParticipantId = undefined;

              if (isTargetCancelled) {
                const cancelledTurn: CollaborationTurnRecord = {
                  id: turnId,
                  runId,
                  round,
                  turnIndex,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  status: "cancelled",
                  inputSummary: `Turn for role ${runtime.roleId}`,
                  startedAt: turnStartedAt,
                  completedAt: turnCompletedAt,
                  durationMs,
                };

                const currentPart = participantsById[runtime.participantId]!;
                const updatedPart: ParticipantRecord = {
                  ...currentPart,
                  status: "cancelled",
                  lastActiveAt: turnCompletedAt,
                };

                runStatus = "failed";
                finalSummary = `Required role participant '${runtime.participantId}' was cancelled; required workflow failed`;

                try {
                  persistence.recordTurnTransaction({
                    turn: cancelledTurn,
                    participant: updatedPart,
                    runUpdates: {
                      id: runId,
                      status: "failed",
                      activeParticipantId: null,
                      finalSummary,
                      completedAt: turnCompletedAt,
                    },
                  });
                } catch (persistErr) {
                  throw new BridgeError(
                    "collaboration_persistence_failed",
                    `Failed to persist target cancellation turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                    false,
                  );
                }

                turns.push(cancelledTurn);
                turnHistory.push(turnId);
                participantsById[runtime.participantId] = updatedPart;
                turnIndex += 1;
                break loop;
              }

              if (isOtherCancelled) {
                const cancelledTurn: CollaborationTurnRecord = {
                  id: turnId,
                  runId,
                  round,
                  turnIndex,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  status: "cancelled",
                  inputSummary: `Turn for role ${runtime.roleId}`,
                  startedAt: turnStartedAt,
                  completedAt: turnCompletedAt,
                  durationMs,
                };

                const currentPart = participantsById[runtime.participantId]!;
                const updatedPart: ParticipantRecord = {
                  ...currentPart,
                  status: "idle",
                  lastActiveAt: turnCompletedAt,
                };

                runStatus = "failed";
                finalSummary = `Required role participant '${[...control.cancelledParticipantIds].join(", ")}' was cancelled; required workflow failed`;

                try {
                  persistence.recordTurnTransaction({
                    turn: cancelledTurn,
                    participant: updatedPart,
                    runUpdates: {
                      id: runId,
                      status: "failed",
                      activeParticipantId: null,
                      finalSummary,
                      completedAt: turnCompletedAt,
                    },
                  });
                } catch (persistErr) {
                  throw new BridgeError(
                    "collaboration_persistence_failed",
                    `Failed to persist interrupted non-target cancellation turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                    false,
                  );
                }

                turns.push(cancelledTurn);
                turnHistory.push(turnId);
                participantsById[runtime.participantId] = updatedPart;
                turnIndex += 1;
                break loop;
              }

              if (isRunCancelled) {
                const cancelledTurn: CollaborationTurnRecord = {
                  id: turnId,
                  runId,
                  round,
                  turnIndex,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  status: "cancelled",
                  inputSummary: `Turn for role ${runtime.roleId}`,
                  startedAt: turnStartedAt,
                  completedAt: turnCompletedAt,
                  durationMs,
                };

                const currentPart = participantsById[runtime.participantId]!;
                const cancelledPart: ParticipantRecord = {
                  ...currentPart,
                  status: "cancelled",
                  lastActiveAt: turnCompletedAt,
                };

                runStatus = "cancelled";
                finalSummary = "Collaboration run was cancelled";

                try {
                  persistence.recordTurnTransaction({
                    turn: cancelledTurn,
                    participant: cancelledPart,
                    runUpdates: {
                      id: runId,
                      status: "cancelled",
                      activeParticipantId: null,
                      finalSummary,
                      completedAt: turnCompletedAt,
                    },
                  });
                } catch (persistErr) {
                  throw new BridgeError(
                    "collaboration_persistence_failed",
                    `Failed to persist cancelled run turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                    false,
                  );
                }

                turns.push(cancelledTurn);
                turnHistory.push(turnId);
                participantsById[runtime.participantId] = cancelledPart;
                turnIndex += 1;
                break loop;
              }

              if (isTimeout) {
                const timeoutTurn: CollaborationTurnRecord = {
                  id: turnId,
                  runId,
                  round,
                  turnIndex,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  status: "failed",
                  inputSummary: `Turn for role ${runtime.roleId}`,
                  error: {
                    code: "agent_adapter_timeout",
                    message: "Exceeded maximum wall-clock deadline",
                    retryable: false,
                  },
                  startedAt: turnStartedAt,
                  completedAt: turnCompletedAt,
                  durationMs,
                };

                const failedPart: ParticipantRecord = {
                  ...participantsById[runtime.participantId]!,
                  status: "failed",
                  consecutiveFailures: (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1,
                  lastActiveAt: turnCompletedAt,
                };

                runStatus = "timed_out";
                finalSummary = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;

                try {
                  persistence.recordTurnTransaction({
                    turn: timeoutTurn,
                    participant: failedPart,
                    runUpdates: {
                      id: runId,
                      status: "timed_out",
                      activeParticipantId: null,
                      finalSummary,
                      completedAt: turnCompletedAt,
                    },
                  });
                } catch (persistErr) {
                  throw new BridgeError(
                    "collaboration_persistence_failed",
                    `Failed to persist timed out turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                    false,
                  );
                }

                turns.push(timeoutTurn);
                turnHistory.push(turnId);
                participantsById[runtime.participantId] = failedPart;
                turnIndex += 1;
                break loop;
              }

              // True operational error thrown by adapter
              const isRetryable = retryableError(turnErr);
              const consecutiveFailures = (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1;
              const turnsExhausted = turnIndex + 1 >= budget.maxTurns;
              const timeExhausted = nowFn() - startTimestamp >= budget.maxWallClockMs;
              const canRetry =
                isRetryable &&
                attemptInRole < maxRetries &&
                !turnsExhausted &&
                !timeExhausted &&
                !control.rootAbortController.signal.aborted &&
                control.cancelledParticipantIds.size === 0;

              let runStatusUpdate: RoleBasedCollaborationRunStatus = "failed";
              let runSummaryUpdate: string | null = turnErr instanceof Error ? turnErr.message : String(turnErr);
              if (canRetry) {
                runStatusUpdate = "running";
                runSummaryUpdate = null;
              } else if (isRetryable && turnsExhausted) {
                runStatusUpdate = "budget_exhausted";
                runSummaryUpdate = `Exceeded maximum allowed turns (${budget.maxTurns})`;
              } else if (isRetryable && timeExhausted) {
                runStatusUpdate = "timed_out";
                runSummaryUpdate = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
              }

              const failedTurn: CollaborationTurnRecord = {
                id: turnId,
                runId,
                round,
                turnIndex,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                status: "failed",
                inputSummary: `Turn for role ${runtime.roleId}`,
                error: {
                  code: turnErr instanceof BridgeError ? turnErr.code : "agent_adapter_failed",
                  message: turnErr instanceof Error ? turnErr.message : String(turnErr),
                  retryable: isRetryable,
                },
                startedAt: turnStartedAt,
                completedAt: turnCompletedAt,
                durationMs,
              };

              const failedPart: ParticipantRecord = {
                ...participantsById[runtime.participantId]!,
                status: canRetry ? "idle" : "failed",
                consecutiveFailures,
                lastActiveAt: turnCompletedAt,
              };

              try {
                persistence.recordTurnTransaction({
                  turn: failedTurn,
                  participant: failedPart,
                  runUpdates: {
                    id: runId,
                    status: runStatusUpdate,
                    activeParticipantId: null,
                    finalSummary: runSummaryUpdate,
                    completedAt: canRetry ? null : turnCompletedAt,
                  },
                });
              } catch (persistErr) {
                throw new BridgeError(
                  "collaboration_persistence_failed",
                  `Failed to persist failed operational turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                  false,
                );
              }

              turns.push(failedTurn);
              turnHistory.push(turnId);
              participantsById[runtime.participantId] = failedPart;
              turnIndex += 1;

              if (canRetry) {
                attemptInRole += 1;
                await runtime.adapter.close?.().catch(() => undefined);
                if (runtime.recreateAdapter) {
                  runtime.adapter = runtime.recreateAdapter();
                }
                initializedParticipants.delete(runtime.participantId);
                continue roleAttemptLoop;
              }

              runStatus = runStatusUpdate;
              finalSummary = runSummaryUpdate ?? undefined;
              break loop;
            } finally {
              control.rootAbortController.signal.removeEventListener("abort", onRootAbort);
              control.activeTurnController = undefined;
            }

            // Normal decision from adapter
            const durationMs = nowFn() - turnStartMs;
            const turnCompletedAt = clock();

            if (decision.type === "error") {
              const consecutiveFailures = (participantsById[runtime.participantId]?.consecutiveFailures ?? 0) + 1;
              const turnsExhausted = turnIndex + 1 >= budget.maxTurns;
              const timeExhausted = nowFn() - startTimestamp >= budget.maxWallClockMs;
              const canRetry =
                decision.retryable &&
                attemptInRole < maxRetries &&
                !turnsExhausted &&
                !timeExhausted &&
                !control.rootAbortController.signal.aborted &&
                control.cancelledParticipantIds.size === 0;

              let runStatusUpdate: RoleBasedCollaborationRunStatus = "failed";
              let runSummaryUpdate: string | null = decision.message;
              if (canRetry) {
                runStatusUpdate = "running";
                runSummaryUpdate = null;
              } else if (decision.retryable && turnsExhausted) {
                runStatusUpdate = "budget_exhausted";
                runSummaryUpdate = `Exceeded maximum allowed turns (${budget.maxTurns})`;
              } else if (decision.retryable && timeExhausted) {
                runStatusUpdate = "timed_out";
                runSummaryUpdate = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
              }

              const normalized = normalizeCanonicalText(decision.message);
              assertMessageWithinSizeBound(normalized);
              const contentHash = computeCollaborationMessageHash({
                runId,
                turnId,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                decisionType: "error",
                content: normalized,
              });
              const messageRecord: CollaborationMessageRecord = {
                id: messageIdFactory(),
                runId,
                turnId,
                sequenceIndex: messageSequenceIndex,
                senderParticipantId: runtime.participantId,
                senderRoleId: runtime.roleId,
                decisionType: "error",
                content: normalized,
                contentHash,
                createdAt: turnCompletedAt,
              };

              const failedTurn: CollaborationTurnRecord = {
                id: turnId,
                runId,
                round,
                turnIndex,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                status: "failed",
                inputSummary: `Turn for role ${runtime.roleId}`,
                decision,
                error: {
                  code: "agent_decision_error",
                  message: decision.message,
                  retryable: decision.retryable,
                },
                startedAt: turnStartedAt,
                completedAt: turnCompletedAt,
                durationMs,
              };

              const failedPart: ParticipantRecord = {
                ...participantsById[runtime.participantId]!,
                status: canRetry ? "idle" : "failed",
                turnsExecuted: participantsById[runtime.participantId]?.turnsExecuted ?? 0,
                consecutiveFailures,
                lastActiveAt: turnCompletedAt,
              };

              try {
                persistence.recordTurnTransaction({
                  turn: failedTurn,
                  message: messageRecord,
                  participant: failedPart,
                  runUpdates: {
                    id: runId,
                    status: runStatusUpdate,
                    round,
                    activeParticipantId: null,
                    finalSummary: runSummaryUpdate,
                    completedAt: canRetry ? null : turnCompletedAt,
                  },
                });
              } catch (persistErr) {
                throw new BridgeError(
                  "collaboration_persistence_failed",
                  `Failed to persist decision error turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                  false,
                );
              }

              turns.push(failedTurn);
              turnHistory.push(turnId);
              participantsById[runtime.participantId] = failedPart;
              messageSequenceIndex += 1;
              turnIndex += 1;
              control.activeParticipantId = undefined;

              if (canRetry) {
                attemptInRole += 1;
                continue roleAttemptLoop;
              }

              runStatus = runStatusUpdate;
              finalSummary = runSummaryUpdate ?? undefined;
              break loop;
            }

            // Normal successful decision: "message" | "done" | "pause"
            let rawContent: string | undefined = undefined;
            if (decision.type === "message") {
              rawContent = decision.content;
            } else if (decision.type === "done") {
              rawContent = decision.summary;
            } else if (decision.type === "pause") {
              rawContent = decision.reason;
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
            let nextFinalSummary: string | null = finalSummary ?? null;
            let nextCompletedAt: string | null = null;

            if (decision.type === "done" && isTerminalRole) {
              nextRunStatus = "completed";
              nextFinalSummary = decision.summary;
              nextCompletedAt = turnCompletedAt;
            } else if (decision.type === "pause") {
              nextRunStatus = "paused";
              nextFinalSummary = decision.reason;
              nextCompletedAt = null;
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
                  activeParticipantId: null,
                  finalSummary: nextFinalSummary,
                  completedAt: nextCompletedAt,
                },
              });
            } catch (persistErr) {
              throw new BridgeError(
                "collaboration_persistence_failed",
                `Failed to persist completed collaboration turn: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                false,
              );
            }

            if (messageRecord) {
              messageSequenceIndex += 1;
            }
            turnIndex += 1;
            turns.push(turnRecord);
            turnHistory.push(turnId);
            participantsById[runtime.participantId] = participantUpdate;
            control.activeParticipantId = undefined;

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
            } else if (decision.type === "pause") {
              runStatus = "paused";
              finalSummary = decision.reason;
              break loop;
            }

            break roleAttemptLoop;
          } // end roleAttemptLoop

          if (runStatus !== "running") {
            break loop;
          }
        } // end roleSequence for

        if (runStatus === "running") {
          if (config.policy.loopMode === "once") {
            runStatus = "completed";
            finalSummary = finalSummary ?? "Role sequence completed.";
            break loop;
          } else if (config.policy.loopMode === "repeat_until_done") {
            round += 1;
          }
        }
      } // end while (runStatus === "running")
    } finally {
      const closed = new Set<string>();
      const initializedReverse = [...initializedParticipants].reverse();
      for (const partId of initializedReverse) {
        closed.add(partId);
        const runtime = runtimesByParticipantId.get(partId);
        try {
          await runtime?.adapter.close?.();
        } catch {
          // Ignore secondary close errors
        }
      }
      for (const runtime of prepared.runtimes) {
        if (!closed.has(runtime.participantId)) {
          closed.add(runtime.participantId);
          try {
            await runtime.adapter.close?.();
          } catch {
            // Ignore secondary close errors
          }
        }
      }
    }

    const completedAt = runStatus === "paused" ? null : clock();
    try {
      persistence.finalizeRun(runId, {
        status: runStatus,
        round,
        finalSummary: finalSummary ?? null,
        completedAt,
        activeParticipantId: null,
      });
    } catch (persistErr) {
      throw new BridgeError(
        "collaboration_persistence_failed",
        `Failed to finalize collaboration run: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        false,
      );
    }

    for (const cancelledId of control.cancelledParticipantIds) {
      if (participantsById[cancelledId]) {
        participantsById[cancelledId] = {
          ...participantsById[cancelledId]!,
          status: "cancelled",
          lastActiveAt: completedAt ?? clock(),
        };
      }
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
      createdAt: initialRun.createdAt,
      startedAt: initialRun.startedAt,
      completedAt: runStatus === "paused" ? undefined : (completedAt ?? undefined),
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
