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
  type RoleExecutionCursor,
  type RoleBasedRecoveryReport,
  type RoleBasedResumeOptions,
  isRoleBasedRunTerminalStatus,
  assertRoleBasedRunPatchAllowed,
  normalizeCancellationReason,
  RoleRunAbortError,
  readRoleRunAbortReason,
  requireValidStartedAt,
  P4_DEFAULT_BUDGET,
} from "./collaboration-domain";

import type {
  PreparedRoleParticipants,
  ParticipantRuntime,
  RoleBasedExecutionResult,
  RoleBasedExecutionOptions,
  ActiveRoleRunControl,
  CollaborationDagExecutionOptions,
  CollaborationDagExecutionResult,
  CollaborationDagRecoveryReport,
  CollaborationDagResumeOptions,
} from "./collaboration-runtime";
import type {
  RoleBasedRunPersistence,
  PersistedParticipant,
} from "./collaboration-persistence";
import {
  type CollaborationMessageRecord,
  computeCollaborationMessageHash,
  assertMessageWithinSizeBound,
  normalizeCanonicalText,
  collaborationMessagesToPriorTurns,
  assertCollaborationMessageIntegrity,
} from "./collaboration-transcript";
import type { PersistedParticipantRestorer } from "../agents/participant-factory";
import {
  emitCollaborationAuditEvent,
  type CollaborationAuditEventType,
  type CollaborationAuditPayloadMap,
} from "./collaboration-audit";
import type { CollaborationDagDefinition } from "./collaboration-dag";
import type { CollaborationDagPersistence } from "./collaboration-dag-persistence";
import { CollaborationDagController } from "./collaboration-dag-controller";



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
  /** Prevents concurrent double-resume attempts for the same runId. */
  private readonly resumingRoleRuns = new Set<string>();
  /** Tracks terminal audit emissions to guarantee exactly one terminal event per run. */
  private readonly settledTerminalAudits = new Set<string>();
  private readonly dagController?: CollaborationDagController;

  private emitRoleAudit<T extends CollaborationAuditEventType>(params: {
    eventType: T;
    runId: string;
    sessionId: string;
    turnId?: string;
    createdAt?: string;
    payload: CollaborationAuditPayloadMap[T];
  }): void {
    emitCollaborationAuditEvent(this.auditStore, params);
  }

  private emitTerminalAudit(
    run: RoleBasedCollaborationRun,
    turnsCount: number,
    context?: {
      round?: number;
      errorCode?: string;
      failureCategory?: string;
      participantId?: string;
      roleId?: string;
      createdAt?: string;
    },
  ): void {
    if (this.settledTerminalAudits.has(run.id)) {
      return;
    }
    const createdAt = context?.createdAt || run.completedAt || new Date().toISOString();
    const round = context?.round ?? run.round;

    switch (run.status) {
      case "completed":
        this.settledTerminalAudits.add(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.completed",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt,
          payload: {
            schemaVersion: 1,
            round,
            totalTurns: turnsCount,
          },
        });
        break;

      case "failed":
        this.settledTerminalAudits.add(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.failed",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt,
          payload: {
            schemaVersion: 1,
            round,
            totalTurns: turnsCount,
            errorCode: context?.errorCode,
            failureCategory: context?.failureCategory,
            participantId: context?.participantId,
            roleId: context?.roleId,
          },
        });
        break;

      case "cancelled":
        this.settledTerminalAudits.add(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.cancelled",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt,
          payload: {
            schemaVersion: 1,
            round,
            totalTurns: turnsCount,
          },
        });
        break;

      case "timed_out":
        this.settledTerminalAudits.add(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.timed_out",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt,
          payload: {
            schemaVersion: 1,
            totalTurns: turnsCount,
            maxWallClockMs: run.budget.maxWallClockMs,
          },
        });
        break;

      case "budget_exhausted":
        this.settledTerminalAudits.add(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.budget_exhausted",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt,
          payload: {
            schemaVersion: 1,
            totalTurns: turnsCount,
            maxTurns: run.budget.maxTurns,
          },
        });
        break;
    }
  }

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
    private readonly restoreParticipants?: PersistedParticipantRestorer,
    dagPersistence?: CollaborationDagPersistence,
  ) {
    if (dagPersistence) {
      this.dagController = new CollaborationDagController(dagPersistence, auditStore);
    }
  }



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
    const [roleCount, dagCount] = await Promise.all([
      this.cancelAllRoleBasedRuns(),
      this.cancelAllDagRuns(),
    ]);
    await this.waitForIdle();
    return results.filter(Boolean).length + roleCount + dagCount;
  }

  async waitForIdle(): Promise<void> {
    while (this.runSettlements.size > 0 || this.roleRunSettlements.size > 0) {
      await Promise.allSettled([
        ...this.runSettlements.values(),
        ...this.roleRunSettlements.values(),
      ]);
    }
    await this.dagController?.waitForIdle();
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
  private requireDagController(): CollaborationDagController {
    if (!this.dagController) {
      throw new BridgeError(
        "collaboration_persistence_unavailable",
        "P5 DAG persistence is not configured for this runtime",
        false,
      );
    }
    return this.dagController;
  }

  /**
   * Starts a bounded static P5 collaboration DAG using already-prepared P4 participants.
   * Existing P4 sequential execution remains untouched.
   */
  async startDagRun(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    graph: CollaborationDagDefinition,
    options?: CollaborationDagExecutionOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const session = await this.sessionManager.get(sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }
    return this.requireDagController().start(sessionId, config, prepared, graph, options);
  }

  async executeDagRun(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    graph: CollaborationDagDefinition,
    options?: CollaborationDagExecutionOptions,
  ): Promise<CollaborationDagExecutionResult> {
    const session = await this.sessionManager.get(sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }
    return this.requireDagController().execute(sessionId, config, prepared, graph, options);
  }

  async waitForDagRun(runId: string): Promise<CollaborationDagExecutionResult> {
    return this.requireDagController().waitForRun(runId);
  }

  getDagRun(runId: string): RoleBasedCollaborationRun | null {
    return this.dagController?.getRun(runId) ?? null;
  }

  async cancelDagRun(
    runId: string,
    reason = "Collaboration DAG run was cancelled",
  ): Promise<boolean> {
    return this.requireDagController().cancelRun(runId, reason);
  }

  async cancelAllDagRuns(): Promise<number> {
    if (!this.dagController) return 0;
    return this.dagController.cancelAllRuns();
  }


  recoverDagRuns(options?: {
    readonly now?: () => number;
    readonly clock?: () => string;
  }): CollaborationDagRecoveryReport {
    if (!this.dagController) {
      return {
        examined: 0,
        pausedAtSafeBoundary: 0,
        interruptedNodesReconciled: 0,
        completedAtRecovery: 0,
        terminalAtRecovery: 0,
        failedRunIds: [],
      };
    }
    return this.dagController.recoverRunningRuns(options);
  }

  async resumeDagRun(
    runId: string,
    options?: CollaborationDagResumeOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const dagController = this.requireDagController();

    // Validate budgets/replay requirements before participant restoration.
    const persistedParticipants = dagController.prepareResume(runId, options);
    const run = dagController.getRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `DAG run '${runId}' not found`, false);
    }

    const session = await this.sessionManager.get(run.sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session ${session.id} is closed`, false);
    }
    if (!this.restoreParticipants) {
      throw new BridgeError(
        "collaboration_restore_unavailable",
        "Persisted participant restoration is not configured for P5 DAG resume",
        false,
      );
    }

    const prepared = this.restoreParticipants(persistedParticipants);
    return dagController.resume(runId, prepared, options);
  }


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

    this.emitRoleAudit({
      eventType: "collaboration.started",
      runId: initialRun.id,
      sessionId: initialRun.sessionId,
      createdAt: initialRun.startedAt ?? nowIso,
      payload: {
        schemaVersion: 1,
        participantCount: initialRun.participantIds.length,
        roleSequence: initialRun.policy.roleSequence,
        loopMode: initialRun.policy.loopMode,
        budget: {
          maxTurns: initialRun.budget.maxTurns,
          maxParticipants: initialRun.budget.maxParticipants,
          maxParallelTurns: 1,
          maxRetriesPerParticipant: initialRun.budget.maxRetriesPerParticipant,
          maxWallClockMs: initialRun.budget.maxWallClockMs,
        },
      },
    });

    for (let seqIdx = 0; seqIdx < initialRun.policy.roleSequence.length; seqIdx++) {
      const roleId = initialRun.policy.roleSequence[seqIdx]!;
      const plan = prepared.plans.find((p) => p.roleId === roleId);
      if (plan) {
        this.emitRoleAudit({
          eventType: "participant.assigned",
          runId: initialRun.id,
          sessionId: initialRun.sessionId,
          createdAt: initialRun.createdAt,
          payload: {
            schemaVersion: 1,
            participantId: plan.participantId,
            roleId: plan.roleId,
            adapterId: plan.adapterId,
            sequenceIndex: seqIdx,
          },
        });
      }
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
      cancelledParticipantReasons: new Map<string, string>(),
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
        if (error instanceof BridgeError && error.code === "collaboration_persistence_failed") {
          throw error;
        }

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
          } catch (persistErr) {
            throw new BridgeError(
              "collaboration_persistence_failed",
              `Failed to persist failure outcome: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
              false,
            );
          }
        }

        const canonicalRun = persistence.getRun(runId);
        if (!canonicalRun) {
          throw new BridgeError("not_found", `Role-based run '${runId}' not found`, false);
        }
        const canonicalTurns = persistence.getTurns(runId);
        this.emitTerminalAudit(canonicalRun, canonicalTurns.length, {
          round: canonicalRun.round,
          createdAt: completedAt,
          errorCode: error instanceof BridgeError ? error.code : undefined,
        });

        const result: RoleBasedExecutionResult = {
          run: canonicalRun,
          turns: canonicalTurns,
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
    const normalizedReason = normalizeCancellationReason(reason);
    const persistence = this.rolePersistence ?? this.activeRoleRuns.get(runId)?.persistence;
    if (!persistence) {
      return false;
    }

    const currentBefore = persistence.getRun(runId);
    if (!currentBefore || isRoleBasedRunTerminalStatus(currentBefore.status) || currentBefore.status !== "running") {
      return false;
    }

    const control = this.activeRoleRuns.get(runId);
    this.emitRoleAudit({
      eventType: "collaboration.cancel.requested",
      runId,
      sessionId: currentBefore.sessionId,
      createdAt: new Date().toISOString(),
      payload: {
        schemaVersion: 1,
        activeParticipantId: control?.activeParticipantId ?? currentBefore.activeParticipantId,
        reasonPresent: Boolean(reason && reason.trim().length > 0),
      },
    });

    if (control) {
      const abortError = new RoleRunAbortError({
        kind: "run_cancelled",
        reason: normalizedReason,
      });

      if (!control.rootAbortController.signal.aborted) {
        control.rootAbortController.abort(abortError);
      }
      if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
        control.activeTurnController.abort(abortError);
      }

      const settlement = this.roleRunSettlements.get(runId);
      if (settlement) {
        await settlement;
      }

      const finalRun = persistence.getRun(runId);
      return finalRun?.status === "cancelled";
    }

    // Run is in persistence but not in activeRoleRuns
    try {
      persistence.finalizeRun(runId, {
        status: "cancelled",
        finalSummary: normalizedReason,
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
    const finalRun = persistence.getRun(runId);
    if (finalRun && finalRun.status === "cancelled") {
      const turns = persistence.getTurns(runId);
      this.emitTerminalAudit(finalRun, turns.length, {
        round: finalRun.round,
        createdAt: finalRun.completedAt ?? new Date().toISOString(),
      });
    }
    return finalRun?.status === "cancelled";
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
    const normalizedReason = normalizeCancellationReason(reason);
    const persistence = this.rolePersistence ?? this.activeRoleRuns.get(runId)?.persistence;
    if (!persistence) {
      throw new BridgeError("run_not_found", `Role-based run ${runId} not found`, false);
    }
    const run = persistence.getRun(runId);
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

    if (isRoleBasedRunTerminalStatus(run.status) || run.status !== "running") {
      return false;
    }

    const control = this.activeRoleRuns.get(runId);
    if (!control) {
      return false;
    }

    if (control.cancelledParticipantIds.has(participantId)) {
      return false;
    }

    control.cancelledParticipantIds.add(participantId);
    control.cancelledParticipantReasons.set(participantId, normalizedReason);

    const nowIso = new Date().toISOString();
    this.emitRoleAudit({
      eventType: "participant.cancel.requested",
      runId,
      sessionId: run.sessionId,
      createdAt: nowIso,
      payload: {
        schemaVersion: 1,
        participantId,
        roleId: run.participantsById[participantId]?.roleId,
        wasActive: control.activeParticipantId === participantId,
        reasonPresent: Boolean(reason && reason.trim().length > 0),
      },
    });

    const abortError = new RoleRunAbortError({
      kind: "participant_cancelled",
      participantId,
      reason: normalizedReason,
    });

    if (control.activeParticipantId === participantId) {
      // Target is active: turn controller abort and root abort will let executeRoleBasedLoop
      // atomically persist turn cancellation, participant cancellation, and run failure together.
      if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
        control.activeTurnController.abort(abortError);
      }
      if (!control.rootAbortController.signal.aborted) {
        control.rootAbortController.abort(abortError);
      }

      const settlement = this.roleRunSettlements.get(runId);
      if (settlement) {
        await settlement;
      }

      const finalRun = persistence.getRun(runId);
      return (
        finalRun?.status === "failed" &&
        finalRun?.participantsById[participantId]?.status === "cancelled"
      );
    } else {
      // Non-active target (idle or pending): atomically mark target participant cancelled and run failed.
      let persistenceError: unknown;
      const currentPart = run.participantsById[participantId];
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
              finalSummary: `Required participant '${participantId}' was cancelled: ${normalizedReason}`,
              completedAt: nowIso,
            },
          });
          const updatedRun = control.persistence.getRun(runId);
          if (updatedRun && isRoleBasedRunTerminalStatus(updatedRun.status)) {
            const turns = control.persistence.getTurns(runId);
            this.emitTerminalAudit(updatedRun, turns.length, {
              round: updatedRun.round,
              failureCategory: "participant_cancelled",
              participantId,
              roleId: run.participantsById[participantId]?.roleId,
              createdAt: nowIso,
            });
          }
        } catch (persistErr) {
          persistenceError = persistErr;
        }
      }

      // Always abort runtime regardless of persistence error
      if (!control.rootAbortController.signal.aborted) {
        control.rootAbortController.abort(abortError);
      }
      if (control.activeTurnController && !control.activeTurnController.signal.aborted) {
        control.activeTurnController.abort(abortError);
      }

      const settlement = this.roleRunSettlements.get(runId);
      if (settlement) {
        try {
          await settlement;
        } catch (settleErr) {
          if (!persistenceError) {
            persistenceError = settleErr;
          }
        }
      }

      if (persistenceError) {
        if (persistenceError instanceof BridgeError) {
          throw persistenceError;
        }
        throw new BridgeError(
          "collaboration_persistence_failed",
          `Failed to persist participant cancellation: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
          false,
        );
      }

      const finalRun = persistence.getRun(runId);
      return (
        finalRun?.status === "failed" &&
        finalRun?.participantsById[participantId]?.status === "cancelled"
      );
    }
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
    cursor?: RoleExecutionCursor,
  ): Promise<RoleBasedExecutionResult> {
    const clock = options?.clock ?? (() => new Date().toISOString());
    const nowFn = options?.now ?? (() => Date.now());
    const turnIdFactory = options?.turnIdFactory ?? generateCollaborationTurnId;
    const messageIdFactory = options?.messageIdFactory ?? generateCollaborationMessageId;
    const persistence = control.persistence;

    // On fresh start: startTimestamp is now.
    // On resume: startTimestamp is parsed from run.startedAt so wall-clock includes
    // the time the daemon was down and the time the run was paused.
    const startTimestamp = cursor
      ? requireValidStartedAt(initialRun, nowFn())
      : nowFn();

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
    // If resuming with a cursor, restore priorTurns from the cursor (already hash-verified)
    let priorTurns: PriorCollaborationTurn[] = cursor ? [...cursor.priorTurns] : [];
    const turnHistory: string[] = [];
    const turns: CollaborationTurnRecord[] = [];
    let messageSequenceIndex = cursor ? cursor.nextMessageSequenceIndex : 0;
    let runStatus: RoleBasedCollaborationRunStatus = "running";
    let finalSummary: string | undefined = undefined;
    // Resume restores round, seqIdx, turnIndex from cursor
    let round = cursor ? cursor.round : 0;
    let turnIndex = cursor ? cursor.nextTurnIndex : 0;
    // Starting seqIdx for the outer loop: on resume, start at cursor.sequenceIndex
    const startSeqIdx = cursor ? cursor.sequenceIndex : 0;

    try {
      let isFirstRound = true;
      loop: while (runStatus === "running") {
        // On the first iteration (resume path): start at cursor.sequenceIndex.
        // On all subsequent iterations (wrap-around in repeat_until_done): start at 0.
        const seqStart = isFirstRound ? startSeqIdx : 0;
        isFirstRound = false;
        for (let seqIdx = seqStart; seqIdx < config.policy.roleSequence.length; seqIdx++) {
          const roleId = config.policy.roleSequence[seqIdx]!;
          const plan = plansByRoleId.get(roleId);
          if (!plan) {
            throw new BridgeError("invalid_request", `Missing plan for role '${roleId}'`, false);
          }
          const runtime = runtimesByParticipantId.get(plan.participantId);
          if (!runtime) {
            throw new BridgeError("invalid_request", `Missing runtime for participant '${plan.participantId}'`, false);
          }

          // On resume: restore consecutiveFailures for the participant being resumed
          const persistedPart = participantsById[runtime.participantId];
          let attemptInRole = cursor && seqIdx === startSeqIdx
            ? (persistedPart?.consecutiveFailures ?? 0)
            : 0;
          const maxRetries = budget.maxRetriesPerParticipant ?? P4_DEFAULT_BUDGET.maxRetriesPerParticipant;

          roleAttemptLoop: while (true) {

            // Check maxTurns budget before turn execution
            if (turnIndex >= budget.maxTurns) {
              runStatus = "budget_exhausted";
              finalSummary = `Exceeded maximum allowed turns (${budget.maxTurns})`;
              this.finalizeRoleRunDurably(persistence, runId, {
                status: "budget_exhausted",
                round,
                activeParticipantId: null,
                finalSummary,
                completedAt: clock(),
              });
              break loop;
            }

            // Check wall-clock deadline before turn execution
            const elapsed = nowFn() - startTimestamp;
            if (elapsed >= budget.maxWallClockMs) {
              runStatus = "timed_out";
              finalSummary = `Exceeded maximum wall-clock deadline (${budget.maxWallClockMs} ms)`;
              this.finalizeRoleRunDurably(persistence, runId, {
                status: "timed_out",
                round,
                activeParticipantId: null,
                finalSummary,
                completedAt: clock(),
              });
              break loop;
            }

            // Check cancellation signal before turn execution
            if (control.cancelledParticipantIds.size > 0) {
              const cancelledId = [...control.cancelledParticipantIds][0]!;
              const partReason = control.cancelledParticipantReasons.get(cancelledId);
              runStatus = "failed";
              finalSummary = partReason
                ? `Required participant '${cancelledId}' was cancelled: ${partReason}`
                : `Required role participant '${cancelledId}' was cancelled; required workflow failed`;
              this.finalizeRoleRunDurably(persistence, runId, {
                status: "failed",
                round,
                activeParticipantId: null,
                finalSummary,
                completedAt: clock(),
              });
              break loop;
            }
            if (control.rootAbortController.signal.aborted) {
              const abortReason = readRoleRunAbortReason(control.rootAbortController.signal.reason);
              runStatus = "cancelled";
              finalSummary = abortReason?.kind === "run_cancelled" ? abortReason.reason : (abortReason ? abortReason.reason : "Collaboration run was cancelled");
              this.finalizeRoleRunDurably(persistence, runId, {
                status: "cancelled",
                round,
                activeParticipantId: null,
                finalSummary,
                completedAt: clock(),
              });
              break loop;
            }

            // Generate turnId for the upcoming turn attempt so turn.started correlation matches committed turn
            const turnId = turnIdFactory();

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

            this.emitRoleAudit({
              eventType: "participant.turn.started",
              runId,
              sessionId,
              turnId,
              createdAt: activeParticipant.lastActiveAt,
              payload: {
                schemaVersion: 1,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                adapterId: plan.adapterId,
                round,
                turnIndex,
                attemptOrdinal: attemptInRole + 1,
              },
            });

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

                this.emitRoleAudit({
                  eventType: "participant.turn.failed",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnTime,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    round,
                    turnIndex: failedTurn.turnIndex,
                    errorCode: failedTurn.error?.code ?? "agent_adapter_failed",
                    retryable: isRetryable,
                    durationMs: 0,
                  },
                });

                if (canRetry) {
                  attemptInRole += 1;
                  this.emitRoleAudit({
                    eventType: "participant.retry.scheduled",
                    runId,
                    sessionId,
                    turnId,
                    createdAt: turnTime,
                    payload: {
                      schemaVersion: 1,
                      participantId: runtime.participantId,
                      roleId: runtime.roleId,
                      retryOrdinal: attemptInRole,
                      maxRetries,
                      nextTurnIndex: turnIndex,
                      recreateRuntime: Boolean(runtime.recreateAdapter),
                    },
                  });
                  await runtime.adapter.close?.().catch(() => undefined);
                  if (runtime.recreateAdapter) {
                    runtime.adapter = runtime.recreateAdapter();
                    this.emitRoleAudit({
                      eventType: "participant.runtime.recreated",
                      runId,
                      sessionId,
                      createdAt: clock(),
                      payload: {
                        schemaVersion: 1,
                        participantId: runtime.participantId,
                        roleId: runtime.roleId,
                        adapterId: plan.adapterId,
                        causeCode: failedTurn.error?.code ?? "agent_adapter_failed",
                      },
                    });
                  }
                  continue roleAttemptLoop;
                }

                runStatus = "failed";
                finalSummary = initErr instanceof Error ? initErr.message : String(initErr);
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  failureCategory: "initialization_failed",
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  errorCode: failedTurn.error?.code ?? "agent_adapter_failed",
                  createdAt: turnTime,
                });
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

                const partReason = control.cancelledParticipantReasons.get(runtime.participantId);
                runStatus = "failed";
                finalSummary = partReason
                  ? `Required participant '${runtime.participantId}' was cancelled: ${partReason}`
                  : `Required role participant '${runtime.participantId}' was cancelled; required workflow failed`;

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

                this.emitRoleAudit({
                  eventType: "participant.turn.cancelled",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    round,
                    turnIndex: cancelledTurn.turnIndex,
                    cancellationScope: "participant",
                  },
                });
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  failureCategory: "participant_cancelled",
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  createdAt: turnCompletedAt,
                });
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

                const otherId = [...control.cancelledParticipantIds][0];
                const partReason = otherId ? control.cancelledParticipantReasons.get(otherId) : undefined;
                runStatus = "failed";
                finalSummary = (otherId && partReason)
                  ? `Required participant '${otherId}' was cancelled: ${partReason}`
                  : `Required role participant '${[...control.cancelledParticipantIds].join(", ")}' was cancelled; required workflow failed`;

                const existingRun = persistence.getRun(runId);
                const terminalCompletedAt = existingRun?.completedAt ?? turnCompletedAt;
                const terminalSummary = existingRun?.finalSummary ?? finalSummary;

                try {
                  persistence.recordTurnTransaction({
                    turn: cancelledTurn,
                    participant: updatedPart,
                    runUpdates: {
                      id: runId,
                      status: "failed",
                      activeParticipantId: null,
                      finalSummary: terminalSummary,
                      completedAt: terminalCompletedAt,
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

                this.emitRoleAudit({
                  eventType: "participant.turn.cancelled",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    round,
                    turnIndex: cancelledTurn.turnIndex,
                    cancellationScope: "participant",
                  },
                });
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  failureCategory: "participant_cancelled",
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  createdAt: turnCompletedAt,
                });
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

                const abortReason = readRoleRunAbortReason(control.rootAbortController.signal.reason);
                runStatus = "cancelled";
                finalSummary = abortReason?.kind === "run_cancelled" ? abortReason.reason : (abortReason ? abortReason.reason : "Collaboration run was cancelled");

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

                this.emitRoleAudit({
                  eventType: "participant.turn.cancelled",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    round,
                    turnIndex: cancelledTurn.turnIndex,
                    cancellationScope: "run",
                  },
                });
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  createdAt: turnCompletedAt,
                });
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

                this.emitRoleAudit({
                  eventType: "participant.turn.failed",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    round,
                    turnIndex: timeoutTurn.turnIndex,
                    errorCode: "agent_adapter_timeout",
                    retryable: false,
                    durationMs,
                  },
                });
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  createdAt: turnCompletedAt,
                });
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

              this.emitRoleAudit({
                eventType: "participant.turn.failed",
                runId,
                sessionId,
                turnId,
                createdAt: turnCompletedAt,
                payload: {
                  schemaVersion: 1,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  round,
                  turnIndex: failedTurn.turnIndex,
                  errorCode: failedTurn.error?.code ?? "agent_adapter_failed",
                  retryable: isRetryable,
                  durationMs,
                },
              });

              if (canRetry) {
                attemptInRole += 1;
                this.emitRoleAudit({
                  eventType: "participant.retry.scheduled",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    retryOrdinal: attemptInRole,
                    maxRetries,
                    nextTurnIndex: turnIndex,
                    recreateRuntime: Boolean(runtime.recreateAdapter),
                  },
                });
                await runtime.adapter.close?.().catch(() => undefined);
                if (runtime.recreateAdapter) {
                  runtime.adapter = runtime.recreateAdapter();
                  this.emitRoleAudit({
                    eventType: "participant.runtime.recreated",
                    runId,
                    sessionId,
                    createdAt: clock(),
                    payload: {
                      schemaVersion: 1,
                      participantId: runtime.participantId,
                      roleId: runtime.roleId,
                      adapterId: plan.adapterId,
                      causeCode: failedTurn.error?.code ?? "agent_adapter_failed",
                    },
                  });
                }
                initializedParticipants.delete(runtime.participantId);
                continue roleAttemptLoop;
              }

              runStatus = runStatusUpdate;
              finalSummary = runSummaryUpdate ?? undefined;
              this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                round,
                failureCategory: attemptInRole >= maxRetries ? "retry_exhausted" : undefined,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                errorCode: failedTurn.error?.code,
                createdAt: turnCompletedAt,
              });
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

              priorTurns = collaborationMessagesToPriorTurns(persistence.getTranscript(runId));

              this.emitRoleAudit({
                eventType: "participant.turn.failed",
                runId,
                sessionId,
                turnId,
                createdAt: turnCompletedAt,
                payload: {
                  schemaVersion: 1,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  round,
                  turnIndex: failedTurn.turnIndex,
                  errorCode: "agent_decision_error",
                  retryable: decision.retryable,
                  durationMs,
                },
              });

              if (canRetry) {
                attemptInRole += 1;
                this.emitRoleAudit({
                  eventType: "participant.retry.scheduled",
                  runId,
                  sessionId,
                  turnId,
                  createdAt: turnCompletedAt,
                  payload: {
                    schemaVersion: 1,
                    participantId: runtime.participantId,
                    roleId: runtime.roleId,
                    retryOrdinal: attemptInRole,
                    maxRetries,
                    nextTurnIndex: turnIndex,
                    recreateRuntime: false,
                  },
                });
                continue roleAttemptLoop;
              }

              runStatus = runStatusUpdate;
              finalSummary = runSummaryUpdate ?? undefined;
              this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                round,
                failureCategory: attemptInRole >= maxRetries ? "retry_exhausted" : undefined,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                errorCode: "agent_decision_error",
                createdAt: turnCompletedAt,
              });
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
              priorTurns = collaborationMessagesToPriorTurns(persistence.getTranscript(runId));
            }
            turnIndex += 1;
            turns.push(turnRecord);
            turnHistory.push(turnId);
            participantsById[runtime.participantId] = participantUpdate;
            control.activeParticipantId = undefined;

            this.emitRoleAudit({
              eventType: "participant.turn.completed",
              runId,
              sessionId,
              turnId,
              createdAt: turnCompletedAt,
              payload: {
                schemaVersion: 1,
                participantId: runtime.participantId,
                roleId: runtime.roleId,
                round,
                turnIndex: turnRecord.turnIndex,
                decisionType: decision.type,
                durationMs,
              },
            });

            if (decision.type === "message") {
              // Message turn completed and priorTurns updated
            } else if (decision.type === "done") {
              if (isTerminalRole) {
                runStatus = "completed";
                finalSummary = decision.summary;
                this.emitTerminalAudit(persistence.getRun(runId)!, turnIndex, {
                  round,
                  createdAt: turnCompletedAt,
                });
                break loop;
              }
            } else if (decision.type === "pause") {
              runStatus = "paused";
              finalSummary = decision.reason;
              this.emitRoleAudit({
                eventType: "collaboration.paused",
                runId,
                sessionId,
                turnId,
                createdAt: turnCompletedAt,
                payload: {
                  schemaVersion: 1,
                  round,
                  turnIndex: turnRecord.turnIndex,
                  participantId: runtime.participantId,
                  roleId: runtime.roleId,
                  reasonPresent: Boolean(decision.reason && decision.reason.trim().length > 0),
                },
              });
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
            this.finalizeRoleRunDurably(persistence, runId, {
              status: "completed",
              round,
              activeParticipantId: null,
              finalSummary,
              completedAt: clock(),
            });
            break loop;
          } else if (config.policy.loopMode === "repeat_until_done") {
            round += 1;
          }
        }
      } // end while (runStatus === "running")

      // Ensure durable terminal/paused settlement BEFORE closing adapters
      const currentPersisted = persistence.getRun(runId);
      if (currentPersisted && !isRoleBasedRunTerminalStatus(currentPersisted.status) && currentPersisted.status !== "paused") {
        const completedAt = runStatus === "paused" ? null : clock();
        this.finalizeRoleRunDurably(persistence, runId, {
          status: runStatus,
          round,
          finalSummary: finalSummary ?? null,
          completedAt,
          activeParticipantId: null,
        });
      }
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

    const canonicalRun = persistence.getRun(runId);
    if (!canonicalRun) {
      throw new BridgeError("not_found", `Role-based run '${runId}' not found`, false);
    }
    const canonicalTurns = persistence.getTurns(runId);
    return {
      run: canonicalRun,
      turns: canonicalTurns,
    };
  }

  private finalizeRoleRunDurably(
    persistence: RoleBasedRunPersistence,
    runId: string,
    updates: RoleBasedRunPatch,
    auditContext?: {
      turnCount?: number;
      errorCode?: string;
      failureCategory?: string;
      participantId?: string;
      roleId?: string;
      createdAt?: string;
    },
  ): RoleBasedCollaborationRun {
    const existing = persistence.getRun(runId);
    if (!existing) {
      throw new BridgeError("not_found", `Role-based run '${runId}' not found`, false);
    }

    if (isRoleBasedRunTerminalStatus(existing.status)) {
      assertRoleBasedRunPatchAllowed(existing, updates);
      return existing;
    }

    persistence.finalizeRun(runId, updates);
    const finalRun = persistence.getRun(runId);
    if (!finalRun) {
      throw new BridgeError("not_found", `Role-based run '${runId}' not found after finalization`, false);
    }

    if (isRoleBasedRunTerminalStatus(finalRun.status)) {
      const turns = persistence.getTurns(runId);
      const turnsCount = auditContext?.turnCount ?? turns.length;
      this.emitTerminalAudit(finalRun, turnsCount, {
        round: updates.round ?? finalRun.round,
        errorCode: auditContext?.errorCode,
        failureCategory: auditContext?.failureCategory,
        participantId: auditContext?.participantId,
        roleId: auditContext?.roleId,
        createdAt: updates.completedAt ?? auditContext?.createdAt ?? finalRun.completedAt ?? undefined,
      });
    }

    return finalRun;
  }

  getRun(runId: string): CollaborationRun | null {
    return this.runStore.get(runId);
  }

  // ============================================================
  // P4.6 — Daemon Recovery
  // ============================================================

  /**
   * Reconciles orphaned role-based runs after a daemon restart.
   *
   * WHY THIS EXISTS:
   *   When the daemon crashes while a run is status=running, the SQLite record is
   *   permanently orphaned in that state. On the next startup, we must identify
   *   these runs and transition them to a safe, queryable state before any new
   *   runs are allowed to start. This prevents ghost-running runs from silently
   *   blocking future schedules or corrupting execution counters.
   *
   * Safety rules:
   * - NEVER spawns adapters, child processes, or network connections.
   * - NEVER auto-resumes — transitions to paused and stops.
   * - NEVER modifies terminal runs.
   * - Processes each run atomically; failures are isolated per-run.
   * - Idempotent: calling twice finds 0 running runs on the second call.
   *
   * Interruption cases:
   *   Case A: run.activeParticipantId === null
   *     → safe boundary (between turns). Transition directly to paused. No synthetic turn.
   *   Case B: run.activeParticipantId !== null
   *     → mid-turn crash. Record synthetic daemon_restarted failed turn, evaluate budgets,
   *       transition to paused (or terminal if budgets exhausted).
   */
  recoverRoleBasedRuns(options?: { now?: () => number; clock?: () => string }): RoleBasedRecoveryReport {
    const persistence = this.rolePersistence;
    if (!persistence) {
      return {
        examined: 0,
        pausedAtSafeBoundary: 0,
        syntheticTurnRecorded: 0,
        budgetExhaustedAtRecovery: 0,
        failedRunIds: [],
      };
    }

    const nowFn = options?.now ?? (() => Date.now());
    const clock = options?.clock ?? (() => new Date().toISOString());

    const orphanedRuns = persistence.listRunsByStatuses(["running"]);
    let pausedAtSafeBoundary = 0;
    let syntheticTurnRecorded = 0;
    let budgetExhaustedAtRecovery = 0;

    for (const run of orphanedRuns) {
      // Skip any run that's already active in this process (should be impossible at startup, but guard)
      if (this.activeRoleRuns.has(run.id)) {
        continue;
      }

      try {
        this._recoverSingleRun(run, persistence, nowFn, clock, {
          onPausedAtSafeBoundary: () => { pausedAtSafeBoundary++; },
          onSyntheticTurnRecorded: () => { syntheticTurnRecorded++; },
          onBudgetExhaustedAtRecovery: () => { budgetExhaustedAtRecovery++; },
        });
      } catch (err) {
        const underlyingMessage = err instanceof Error ? err.message : String(err);
        const underlyingCode = err instanceof BridgeError ? err.code : "unknown";
        throw new BridgeError(
          "role_run_recovery_failed",
          `Failed to recover role-based run '${run.id}' (${underlyingCode}): ${underlyingMessage}`,
          false,
        );
      }
    }

    return {
      examined: orphanedRuns.length,
      pausedAtSafeBoundary,
      syntheticTurnRecorded,
      budgetExhaustedAtRecovery,
      failedRunIds: [],
    };
  }

  private _recoverSingleRun(
    run: RoleBasedCollaborationRun,
    persistence: RoleBasedRunPersistence,
    nowFn: () => number,
    clock: () => string,
    callbacks: {
      onPausedAtSafeBoundary: () => void;
      onSyntheticTurnRecorded: () => void;
      onBudgetExhaustedAtRecovery: () => void;
    },
  ): void {
    const nowMs = nowFn();
    const nowIso = clock();
    const originMs = requireValidStartedAt(run, nowMs);
    const wallClockElapsed = nowMs - originMs;

    if (!run.activeParticipantId) {
      // Case A: safe boundary — no active participant when crash occurred.
      // Validate that no participant in participantsById is currently marked "active"
      for (const [pId, part] of Object.entries(run.participantsById)) {
        if (part.status === "active") {
          throw new BridgeError(
            "persistence_corruption",
            `Run '${run.id}' has no activeParticipantId but participant '${pId}' has status 'active'`,
            false,
          );
        }
      }

      // Safe-boundary budget precedence:
      // 1. wall-clock expiration -> timed_out
      // 2. turn budget exhaustion -> budget_exhausted
      // 3. otherwise safe paused boundary -> paused
      if (wallClockElapsed >= run.budget.maxWallClockMs) {
        persistence.finalizeRun(run.id, {
          status: "timed_out",
          activeParticipantId: null,
          completedAt: nowIso,
          finalSummary: `Exceeded maximum wall-clock deadline (${run.budget.maxWallClockMs} ms)`,
        });
        const existingTurns = persistence.getTurns(run.id);
        this.emitRoleAudit({
          eventType: "collaboration.recovered",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt: nowIso,
          payload: {
            schemaVersion: 1,
            recoveryKind: "safe_boundary",
            outcomeStatus: "timed_out",
            syntheticTurn: false,
          },
        });
        this.emitTerminalAudit(persistence.getRun(run.id)!, existingTurns.length, {
          createdAt: nowIso,
        });
        callbacks.onBudgetExhaustedAtRecovery();
        return;
      }

      const existingTurns = persistence.getTurns(run.id);
      if (existingTurns.length >= run.budget.maxTurns) {
        persistence.finalizeRun(run.id, {
          status: "budget_exhausted",
          activeParticipantId: null,
          completedAt: nowIso,
          finalSummary: `Exceeded maximum allowed turns (${run.budget.maxTurns})`,
        });
        this.emitRoleAudit({
          eventType: "collaboration.recovered",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt: nowIso,
          payload: {
            schemaVersion: 1,
            recoveryKind: "safe_boundary",
            outcomeStatus: "budget_exhausted",
            syntheticTurn: false,
          },
        });
        this.emitTerminalAudit(persistence.getRun(run.id)!, existingTurns.length, {
          createdAt: nowIso,
        });
        callbacks.onBudgetExhaustedAtRecovery();
        return;
      }

      persistence.finalizeRun(run.id, {
        status: "paused",
        activeParticipantId: null,
        finalSummary: null,
      });
      this.emitRoleAudit({
        eventType: "collaboration.recovered",
        runId: run.id,
        sessionId: run.sessionId,
        createdAt: nowIso,
        payload: {
          schemaVersion: 1,
          recoveryKind: "safe_boundary",
          outcomeStatus: "paused",
          syntheticTurn: false,
        },
      });
      this.emitRoleAudit({
        eventType: "collaboration.paused",
        runId: run.id,
        sessionId: run.sessionId,
        createdAt: nowIso,
        payload: {
          schemaVersion: 1,
          round: run.round,
          turnIndex: existingTurns.length,
          reasonPresent: false,
        },
      });
      callbacks.onPausedAtSafeBoundary();
      return;
    }

    // Case B: crash during an active participant turn
    const activeParticipantId = run.activeParticipantId;
    const activeParticipant = run.participantsById[activeParticipantId];
    if (!activeParticipant) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}' references activeParticipantId '${activeParticipantId}' which does not exist in participantsById`,
        false,
      );
    }

    const existingTurns = persistence.getTurns(run.id);
    const turnsBeforeSynthetic = existingTurns.length;
    if (turnsBeforeSynthetic >= run.budget.maxTurns) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}' has active participant '${activeParticipantId}' but turn count already reached or exceeded maxTurns (${turnsBeforeSynthetic} >= ${run.budget.maxTurns})`,
        false,
      );
    }

    const syntheticTurnIndex = turnsBeforeSynthetic;
    const turnsAfterSynthetic = turnsBeforeSynthetic + 1;
    const consecutiveFailures = (activeParticipant.consecutiveFailures ?? 0) + 1;

    // Evaluate budget state at recovery time
    const wallClockExpired = wallClockElapsed >= run.budget.maxWallClockMs;
    const turnsExhausted = turnsAfterSynthetic >= run.budget.maxTurns;
    const retriesExhausted = consecutiveFailures > run.budget.maxRetriesPerParticipant;

    // Determine final status after synthetic turn
    let finalStatus: RoleBasedCollaborationRunStatus;
    let finalSummary: string;
    let finalCompletedAt: string | null;

    if (wallClockExpired) {
      finalStatus = "timed_out";
      finalSummary = `Exceeded maximum wall-clock deadline (${run.budget.maxWallClockMs} ms)`;
      finalCompletedAt = nowIso;
      callbacks.onBudgetExhaustedAtRecovery();
    } else if (turnsExhausted) {
      finalStatus = "budget_exhausted";
      finalSummary = `Exceeded maximum allowed turns (${run.budget.maxTurns})`;
      finalCompletedAt = nowIso;
      callbacks.onBudgetExhaustedAtRecovery();
    } else if (retriesExhausted) {
      finalStatus = "failed";
      finalSummary = `Required participant '${activeParticipantId}' exhausted retry budget after daemon restart`;
      finalCompletedAt = nowIso;
      callbacks.onBudgetExhaustedAtRecovery();
    } else {
      finalStatus = "paused";
      finalSummary = `Daemon restarted while participant '${activeParticipantId}' was executing turn ${syntheticTurnIndex}`;
      finalCompletedAt = null;
    }

    let turnStartedAt = nowIso;
    if (activeParticipant.lastActiveAt) {
      const parsedLastActive = Date.parse(activeParticipant.lastActiveAt);
      if (Number.isFinite(parsedLastActive) && parsedLastActive <= nowMs) {
        turnStartedAt = activeParticipant.lastActiveAt;
      }
    }
    const turnCompletedAt = nowIso;

    const syntheticTurnId = generateCollaborationTurnId();
    const syntheticTurn: CollaborationTurnRecord = {
      id: syntheticTurnId,
      runId: run.id,
      round: run.round,
      turnIndex: syntheticTurnIndex,
      participantId: activeParticipantId,
      roleId: activeParticipant.roleId,
      status: "failed",
      inputSummary: `Turn interrupted by daemon restart (participant: ${activeParticipantId})`,
      error: {
        code: "daemon_restarted",
        message: `Daemon restarted during participant turn. The participant may have executed side effects before the crash.`,
        retryable: true,
      },
      startedAt: turnStartedAt,
      completedAt: turnCompletedAt,
      // durationMs intentionally omitted — duration is unknown after crash
    };

    const updatedParticipant: ParticipantRecord = {
      ...activeParticipant,
      status: finalStatus === "failed" || finalStatus === "timed_out" || finalStatus === "budget_exhausted"
        ? "failed"
        : "idle",
      consecutiveFailures,
      lastActiveAt: turnCompletedAt,
    };

    // Atomic: write synthetic turn + update participant + transition run status
    persistence.recordTurnTransaction({
      turn: syntheticTurn,
      // No message record — daemon_restarted turns do NOT produce canonical output
      participant: updatedParticipant,
      runUpdates: {
        id: run.id,
        status: finalStatus,
        activeParticipantId: null,
        finalSummary,
        completedAt: finalCompletedAt,
      },
    });

    this.emitRoleAudit({
      eventType: "participant.turn.failed",
      runId: run.id,
      sessionId: run.sessionId,
      turnId: syntheticTurnId,
      createdAt: turnCompletedAt,
      payload: {
        schemaVersion: 1,
        participantId: activeParticipantId,
        roleId: activeParticipant.roleId,
        round: run.round,
        turnIndex: syntheticTurnIndex,
        errorCode: "daemon_restarted",
        retryable: true,
      },
    });

    this.emitRoleAudit({
      eventType: "collaboration.recovered",
      runId: run.id,
      sessionId: run.sessionId,
      turnId: syntheticTurnId,
      createdAt: turnCompletedAt,
      payload: {
        schemaVersion: 1,
        recoveryKind: "interrupted_turn",
        outcomeStatus: finalStatus,
        participantId: activeParticipantId,
        turnIndex: syntheticTurnIndex,
        syntheticTurn: true,
      },
    });

    if (finalStatus === "paused") {
      this.emitRoleAudit({
        eventType: "collaboration.paused",
        runId: run.id,
        sessionId: run.sessionId,
        turnId: syntheticTurnId,
        createdAt: turnCompletedAt,
        payload: {
          schemaVersion: 1,
          round: run.round,
          turnIndex: syntheticTurnIndex,
          participantId: activeParticipantId,
          roleId: activeParticipant.roleId,
          reasonPresent: true,
        },
      });
    } else {
      this.emitTerminalAudit(persistence.getRun(run.id)!, turnsAfterSynthetic, {
        round: run.round,
        errorCode: finalStatus === "failed" ? "retry_exhausted" : undefined,
        failureCategory: finalStatus === "failed" ? "retry_exhausted" : undefined,
        participantId: activeParticipantId,
        roleId: activeParticipant.roleId,
        createdAt: turnCompletedAt,
      });
    }

    callbacks.onSyntheticTurnRecorded();
  }

  // ============================================================
  // P4.6 — Safe Explicit Resume
  // ============================================================

  /**
   * Safely resumes a paused role-based collaboration run.
   *
   * WHY THIS EXISTS:
   *   After a daemon_restarted or participant-issued pause, the run is left in a
   *   well-defined paused state with all turns canonically persisted. Resume must
   *   reconstruct the exact execution cursor from persistence (no in-memory guessing),
   *   validate all budgets against the original wall-clock origin (run.startedAt),
   *   require explicit acknowledgement if the last relevant turn was interrupted by a crash,
   *   and then execute exactly as if the run had never paused.
   *
   * Validation order (fail-closed at each step):
   *   1. Load canonical run → verify paused
   *   2. Reserve resume lock (prevent double-resume)
   *   3. Load participants/turns/transcript
   *   4. Derive and validate execution cursor (hash integrity + provenance)
   *   4.5 Check loopMode = "once" already-complete cursor → finalize completed without adapters
   *   5. Validate replay requirement vs allowReplayInterruptedTurn
   *   6. Check wall-clock budget from original startedAt → persist timed_out if expired
   *   7. Check maxTurns budget → persist budget_exhausted if reached
   *   8. Validate bridge session (not closed)
   *   9. Preflight/restore participants (non-spawning)
   *   10. Persist paused → running transition
   *   11. Register ActiveRoleRunControl
   *   12. Execute loop
   *
   * Scope constraints:
   * - No automatic resume on startup (must be called explicitly)
   * - No REST route in P4.6 (internal/controller API only)
   */
  async resumeRoleBasedRun(
    runId: string,
    options?: RoleBasedResumeOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const persistence = this.requireRolePersistence();

    // Step 1: Load canonical run and verify paused
    const run = persistence.getRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `Role-based run '${runId}' not found`, false);
    }
    if (run.status !== "paused") {
      throw new BridgeError(
        "invalid_state_transition",
        `Cannot resume role-based run '${runId}' with status '${run.status}' (must be 'paused')`,
        false,
      );
    }

    // Step 2: Reserve resume lock
    if (this.resumingRoleRuns.has(runId)) {
      throw new BridgeError(
        "resume_in_progress",
        `Run '${runId}' is already being resumed`,
        false,
      );
    }
    this.resumingRoleRuns.add(runId);

    try {
      return await this._executeResume(run, persistence, options);
    } finally {
      this.resumingRoleRuns.delete(runId);
    }
  }

  private async _executeResume(
    run: RoleBasedCollaborationRun,
    persistence: RoleBasedRunPersistence,
    options?: RoleBasedResumeOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const nowFn = options?.now ?? (() => Date.now());
    const clock = options?.clock ?? (() => new Date().toISOString());
    const nowMs = nowFn();

    // Step 3: Load participants, turns, transcript
    const participants = persistence.getParticipants(run.id);
    const turns = persistence.getTurns(run.id);
    const messages = persistence.getTranscript(run.id);

    // Step 4: Derive execution cursor (validates turn/message continuity + hash integrity + provenance)
    const cursor = deriveRoleExecutionCursor(run, participants, turns, messages);

    // Step 4.5: loopMode = "once" already-complete cursor check (Item 32)
    if (run.policy.loopMode === "once" && cursor.sequenceIndex >= run.policy.roleSequence.length) {
      persistence.finalizeRun(run.id, {
        status: "completed",
        activeParticipantId: null,
        completedAt: clock(),
        finalSummary: run.finalSummary ?? "All workflow roles completed successfully",
      });
      const finalRun = persistence.getRun(run.id);
      if (!finalRun) {
        throw new BridgeError("not_found", `Role-based run '${run.id}' not found after completion finalization`, false);
      }
      this.emitTerminalAudit(finalRun, turns.length, {
        round: run.round,
        createdAt: finalRun.completedAt ?? undefined,
      });
      return finalRun;
    }

    // Step 5: Validate replay requirement
    if (cursor.interruptedTurnReplayRequired && options?.allowReplayInterruptedTurn !== true) {
      throw new BridgeError(
        "resume_replay_confirmation_required",
        `Run '${run.id}' was interrupted by a daemon crash during participant '${cursor.interruptedParticipantId}' turn. ` +
        `The participant may have executed filesystem writes, terminal commands, or external side effects before the crash. ` +
        `Set allowReplayInterruptedTurn=true to acknowledge and replay the interrupted turn.`,
        false,
      );
    }

    // Step 6: Check wall-clock budget from original startedAt (Item 33, 34, 36)
    const originMs = requireValidStartedAt(run, nowMs);
    const wallClockElapsed = nowMs - originMs;
    if (wallClockElapsed >= run.budget.maxWallClockMs) {
      const completedAt = clock();
      persistence.finalizeRun(run.id, {
        status: "timed_out",
        activeParticipantId: null,
        completedAt,
        finalSummary: `Exceeded maximum wall-clock deadline (${run.budget.maxWallClockMs} ms)`,
      });
      const finalRun = persistence.getRun(run.id)!;
      this.emitTerminalAudit(finalRun, turns.length, {
        round: run.round,
        createdAt: completedAt,
      });
      throw new BridgeError(
        "timed_out",
        `Run '${run.id}' wall-clock budget exhausted (${wallClockElapsed} ms elapsed, limit ${run.budget.maxWallClockMs} ms). Cannot resume.`,
        false,
      );
    }

    // Step 7: Check maxTurns budget (Item 33, 35, 36)
    if (cursor.nextTurnIndex >= run.budget.maxTurns) {
      const completedAt = clock();
      persistence.finalizeRun(run.id, {
        status: "budget_exhausted",
        activeParticipantId: null,
        completedAt,
        finalSummary: `Exceeded maximum allowed turns (${run.budget.maxTurns})`,
      });
      const finalRun = persistence.getRun(run.id)!;
      this.emitTerminalAudit(finalRun, turns.length, {
        round: run.round,
        createdAt: completedAt,
      });
      throw new BridgeError(
        "budget_exhausted",
        `Run '${run.id}' turn budget exhausted (${cursor.nextTurnIndex} turns consumed, limit ${run.budget.maxTurns}). Cannot resume.`,
        false,
      );
    }

    // Step 8: Validate bridge session
    const session = await this.sessionManager.get(run.sessionId);
    if (session.status === "closed" || session.status === "closing") {
      throw new BridgeError("session_closed", `Session '${run.sessionId}' is closed`, false);
    }

    // Step 9: Preflight/restore participants using persisted snapshots
    if (!this.restoreParticipants) {
      throw new BridgeError(
        "role_persistence_unavailable",
        "resumeRoleBasedRun requires a restoreParticipants function to be configured on RunController",
        false,
      );
    }
    const prepared = this.restoreParticipants(participants);

    // Step 10: Persist paused → running transition
    persistence.finalizeRun(run.id, {
      status: "running",
      activeParticipantId: null,
      finalSummary: null,
    });

    // Load the freshly-updated run as initialRun for the loop
    const resumedRun = persistence.getRun(run.id);
    if (!resumedRun) {
      throw new BridgeError("not_found", `Role-based run '${run.id}' not found after resume transition`, false);
    }

    const nextRoleId = run.policy.roleSequence[cursor.sequenceIndex];
    const nextParticipantId = run.participantIds[cursor.sequenceIndex];
    const replayAcknowledged = Boolean(cursor.interruptedTurnReplayRequired && options?.allowReplayInterruptedTurn === true);

    if (replayAcknowledged) {
      const interruptedTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
      const interruptedParticipantId = cursor.interruptedParticipantId ?? nextParticipantId;
      const interruptedRoleId = (interruptedTurn && interruptedTurn.participantId === interruptedParticipantId)
        ? interruptedTurn.roleId
        : nextRoleId;
      const interruptedTurnIndex = interruptedTurn ? interruptedTurn.turnIndex : (cursor.nextTurnIndex - 1);

      this.emitRoleAudit({
        eventType: "collaboration.replay.acknowledged",
        runId: run.id,
        sessionId: run.sessionId,
        createdAt: clock(),
        payload: {
          schemaVersion: 1,
          participantId: interruptedParticipantId,
          roleId: interruptedRoleId,
          interruptedTurnIndex,
        },
      });
    }

    this.emitRoleAudit({
      eventType: "collaboration.resumed",
      runId: run.id,
      sessionId: run.sessionId,
      createdAt: clock(),
      payload: {
        schemaVersion: 1,
        round: cursor.round,
        sequenceIndex: cursor.sequenceIndex,
        nextTurnIndex: cursor.nextTurnIndex,
        participantId: nextParticipantId,
        roleId: nextRoleId,
        replayAcknowledged,
      },
    });

    // Step 11: Register ActiveRoleRunControl
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
      runId: run.id,
      rootAbortController,
      persistence,
      cancelledParticipantIds: new Set<string>(),
      cancelledParticipantReasons: new Map<string, string>(),
    };
    this.activeRoleRuns.set(run.id, control);

    // Reconstruct CollaborationConfig from persisted run data
    const resumeConfig: CollaborationConfig = {
      objective: resumedRun.objective,
      policy: resumedRun.policy,
      // roles not used in the loop directly (plans come from prepared)
      roles: {},
      budget: resumedRun.budget,
    };

    // Reconstruct RoleBasedExecutionOptions for the loop
    const loopOptions: RoleBasedExecutionOptions = {
      signal: options?.signal,
      clock,
      now: nowFn,
    };

    // Step 12: Execute loop with cursor
    const settlement = this.executeRoleBasedLoop(
      run.id,
      run.sessionId,
      resumeConfig,
      prepared,
      control,
      loopOptions,
      resumedRun,
      cursor,
    )
      .catch((error) => {
        if (error instanceof BridgeError && error.code === "collaboration_persistence_failed") {
          throw error;
        }

        const currentRun = persistence.getRun(run.id);
        const finalStatus: RoleBasedCollaborationRunStatus = control.rootAbortController.signal.aborted
          ? "cancelled"
          : "failed";
        const completedAt = clock();
        const finalSummary = error instanceof Error ? error.message : String(error);
        if (currentRun && !isRoleBasedRunTerminalStatus(currentRun.status)) {
          try {
            persistence.finalizeRun(run.id, {
              status: finalStatus,
              finalSummary,
              completedAt,
              activeParticipantId: null,
            });
          } catch (persistErr) {
            throw new BridgeError(
              "collaboration_persistence_failed",
              `Failed to persist resume failure outcome: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
              false,
            );
          }
        }

        const canonicalRun = persistence.getRun(run.id);
        if (!canonicalRun) {
          throw new BridgeError("not_found", `Role-based run '${run.id}' not found`, false);
        }
        const canonicalTurns = persistence.getTurns(run.id);
        this.emitTerminalAudit(canonicalRun, canonicalTurns.length, {
          round: canonicalRun.round,
          errorCode: finalStatus === "failed" ? (error instanceof BridgeError ? error.code : "runtime_error") : undefined,
          createdAt: completedAt,
        });
        return { run: canonicalRun, turns: canonicalTurns };
      })
      .finally(() => {
        if (options?.signal) {
          options.signal.removeEventListener("abort", onSignalAbort);
        }
        this.activeRoleRuns.delete(run.id);
        this.roleRunSettlements.delete(run.id);
      });

    this.roleRunSettlements.set(run.id, settlement);
    return resumedRun;
  }
}

// ============================================================
// P4.6 — Pure Cursor Derivation (no DB calls, no network, no processes)
// ============================================================

/**
 * Derives a deterministic RoleExecutionCursor from persisted run state.
 *
 * WHY THIS EXISTS:
 *   After a daemon crash or explicit pause, we need to reconstruct exactly where
 *   execution should resume without any in-memory state. This function is the single
 *   authoritative source for that reconstruction. It is a pure function (zero side effects)
 *   so it can be tested deterministically without database infrastructure.
 *
 * Algorithm:
 *   1. Validate startedAt timestamp existence and integrity.
 *   2. Validate paused invariants (activeParticipantId must be undefined; no participant active).
 *   3. Validate participant identity graph against policy.roleSequence and participantIds.
 *   4. Validate turn sequence continuity (turnIndex: 0..N-1) and provenance.
 *   5. Validate message sequence continuity (sequenceIndex: 0..M-1), hash integrity,
 *      association to existing turns, and consistency with turn decisions.
 *   6. Replay turns in order to deterministically derive round, sequenceIndex,
 *      consecutiveFailures, and turnsExecuted counters.
 *   7. Validate participant execution counters against replayed canonical history.
 *   8. Determine whether an interrupted turn replay acknowledgement is required.
 *
 * Failures are fail-closed: any integrity violation throws BridgeError("persistence_corruption", ...)
 */
export function deriveRoleExecutionCursor(
  run: RoleBasedCollaborationRun,
  participants: readonly PersistedParticipant[],
  turns: readonly CollaborationTurnRecord[],
  messages: readonly CollaborationMessageRecord[],
): RoleExecutionCursor {
  // 1. Validate startedAt (required for wall-clock tracking)
  requireValidStartedAt(run);

  // 2. Validate paused run invariants (Item 30)
  if (run.status === "paused") {
    if (run.activeParticipantId !== undefined && run.activeParticipantId !== null) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}' has status 'paused' but activeParticipantId is set to '${run.activeParticipantId}'`,
        false,
      );
    }
    for (const p of participants) {
      if (p.status === "active") {
        throw new BridgeError(
          "persistence_corruption",
          `Run '${run.id}' has status 'paused' but participant '${p.id}' has status 'active'`,
          false,
        );
      }
    }
    for (const [pId, pRecord] of Object.entries(run.participantsById)) {
      if (pRecord.status === "active") {
        throw new BridgeError(
          "persistence_corruption",
          `Run '${run.id}' has status 'paused' but participant '${pId}' in participantsById has status 'active'`,
          false,
        );
      }
    }
  }

  const policy = run.policy;
  const roleSequence = policy.roleSequence;
  const numRoles = roleSequence.length;

  // 3. Validate participant identity graph (Item 21)
  if (
    participants.length !== run.participantIds.length ||
    run.participantIds.length !== numRoles
  ) {
    throw new BridgeError(
      "persistence_corruption",
      `Run '${run.id}': participant count mismatch (participants=${participants.length}, participantIds=${run.participantIds.length}, roleSequence=${numRoles})`,
      false,
    );
  }

  if (new Set(run.participantIds).size !== run.participantIds.length) {
    throw new BridgeError(
      "persistence_corruption",
      `Run '${run.id}': duplicate participant IDs in participantIds list`,
      false,
    );
  }

  if (new Set(participants.map((p) => p.id)).size !== participants.length) {
    throw new BridgeError(
      "persistence_corruption",
      `Run '${run.id}': duplicate participant IDs in persisted participants`,
      false,
    );
  }

  const sortedParticipants = [...participants].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (let i = 0; i < sortedParticipants.length; i++) {
    const p = sortedParticipants[i]!;
    if (p.sequenceIndex !== i) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant sequence gap detected at position ${i} (found sequenceIndex=${p.sequenceIndex})`,
        false,
      );
    }
    if (p.runId !== run.id) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' belongs to run '${p.runId}'`,
        false,
      );
    }
    if (p.id !== run.participantIds[i]) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant sequenceIndex ${i} ID mismatch: expected '${run.participantIds[i]}', found '${p.id}'`,
        false,
      );
    }
    if (p.roleId !== roleSequence[i]) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant sequenceIndex ${i} role mismatch: expected '${roleSequence[i]}', found '${p.roleId}'`,
        false,
      );
    }
    const fromById = run.participantsById[p.id];
    if (!fromById) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' missing from run.participantsById`,
        false,
      );
    }
    if (fromById.roleId !== p.roleId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' role mismatch between participantsById ('${fromById.roleId}') and persisted participant ('${p.roleId}')`,
        false,
      );
    }
  }

  const participantMap = new Map<string, PersistedParticipant>();
  for (const p of sortedParticipants) {
    participantMap.set(p.id, p);
  }

  // 4. Validate turn sequence continuity and structure (Item 22)
  const sortedTurns = [...turns].sort((a, b) => a.turnIndex - b.turnIndex);
  for (let i = 0; i < sortedTurns.length; i++) {
    const turn = sortedTurns[i]!;
    if (turn.turnIndex !== i) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn index gap detected at position ${i} (found turnIndex=${turn.turnIndex})`,
        false,
      );
    }
    if (turn.runId !== run.id) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn '${turn.id}' belongs to run '${turn.runId}'`,
        false,
      );
    }
    const participant = participantMap.get(turn.participantId);
    if (!participant) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn '${turn.id}' references unknown participant '${turn.participantId}'`,
        false,
      );
    }
    if (turn.roleId !== participant.roleId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn '${turn.id}' role '${turn.roleId}' does not match participant role '${participant.roleId}'`,
        false,
      );
    }
  }

  const turnsById = new Map<string, CollaborationTurnRecord>();
  for (const t of sortedTurns) {
    turnsById.set(t.id, t);
  }

  // 5. Validate message sequence continuity, hash integrity, and decision consistency (Items 25, 26, 27)
  const sortedMessages = [...messages].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (let i = 0; i < sortedMessages.length; i++) {
    const msg = sortedMessages[i]!;
    if (msg.sequenceIndex !== i) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message sequence gap detected at position ${i} (found sequenceIndex=${msg.sequenceIndex})`,
        false,
      );
    }
    if (msg.runId !== run.id) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' belongs to run '${msg.runId}'`,
        false,
      );
    }
    assertCollaborationMessageIntegrity(msg);

    const turn = turnsById.get(msg.turnId);
    if (!turn) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' references nonexistent turn '${msg.turnId}'`,
        false,
      );
    }
    if (msg.senderParticipantId !== turn.participantId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' senderParticipantId '${msg.senderParticipantId}' does not match turn participant '${turn.participantId}'`,
        false,
      );
    }
    if (msg.senderRoleId !== turn.roleId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' senderRoleId '${msg.senderRoleId}' does not match turn role '${turn.roleId}'`,
        false,
      );
    }

    // Operational failures (daemon_restarted, timeout, cancelled, adapter threw) must NOT have canonical messages (Item 27)
    if (!turn.decision || turn.error?.code === "daemon_restarted" || turn.status === "cancelled") {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn '${turn.id}' is an operational failure or cancelled turn and must not produce a canonical message`,
        false,
      );
    }

    // Decision type and content consistency (Item 26)
    if (msg.decisionType !== turn.decision.type) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' decisionType '${msg.decisionType}' does not match turn decision type '${turn.decision.type}'`,
        false,
      );
    }

    let expectedText = "";
    if (turn.decision.type === "message") {
      expectedText = turn.decision.content;
    } else if (turn.decision.type === "done") {
      expectedText = turn.decision.summary;
    } else if (turn.decision.type === "pause") {
      expectedText = turn.decision.reason;
    } else if (turn.decision.type === "error") {
      expectedText = turn.decision.message;
    }

    if (normalizeCanonicalText(msg.content) !== normalizeCanonicalText(expectedText)) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': message '${msg.id}' content does not match turn decision text: expected '${expectedText}', found '${msg.content}'`,
        false,
      );
    }
  }

  // 6. Turn scheduling replay & round validation (Items 22, 23, 24, 28, 29)
  let round = 0;
  let seqIdx = 0;
  const derivedTurnsExecuted = new Map<string, number>();
  const derivedConsecutiveFailures = new Map<string, number>();
  for (const p of sortedParticipants) {
    derivedTurnsExecuted.set(p.id, 0);
    derivedConsecutiveFailures.set(p.id, 0);
  }

  for (const turn of sortedTurns) {
    if (seqIdx >= numRoles) {
      if (policy.loopMode === "repeat_until_done") {
        seqIdx = 0;
        round += 1;
      } else {
        throw new BridgeError(
          "persistence_corruption",
          `Run '${run.id}': turn ${turn.turnIndex} executed after 'once' loopMode sequence was already complete`,
          false,
        );
      }
    }

    const expectedParticipantId = run.participantIds[seqIdx]!;
    const expectedRoleId = roleSequence[seqIdx]!;

    if (turn.participantId !== expectedParticipantId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn ${turn.turnIndex} participant '${turn.participantId}' does not match expected participant '${expectedParticipantId}' at round ${round}, seqIdx ${seqIdx}`,
        false,
      );
    }
    if (turn.roleId !== expectedRoleId) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn ${turn.turnIndex} role '${turn.roleId}' does not match expected role '${expectedRoleId}' at round ${round}, seqIdx ${seqIdx}`,
        false,
      );
    }
    if (turn.round !== round) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn ${turn.turnIndex} round ${turn.round} does not match derived round ${round}`,
        false,
      );
    }

    if (turn.status === "completed") {
      derivedTurnsExecuted.set(turn.participantId, (derivedTurnsExecuted.get(turn.participantId) ?? 0) + 1);
      derivedConsecutiveFailures.set(turn.participantId, 0);
      seqIdx += 1;
      if (seqIdx >= numRoles && policy.loopMode === "repeat_until_done") {
        seqIdx = 0;
        round += 1;
      }
    } else if (turn.status === "failed") {
      derivedConsecutiveFailures.set(turn.participantId, (derivedConsecutiveFailures.get(turn.participantId) ?? 0) + 1);
      // Failed turn: seqIdx and round do NOT advance
    } else if (turn.status === "cancelled") {
      // Cancelled turn: seqIdx and round do NOT advance
    } else {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': turn ${turn.turnIndex} has invalid status '${turn.status}'`,
        false,
      );
    }
  }

  // 7. Validate execution counters (Items 28, 29)
  for (const p of sortedParticipants) {
    const expectedExec = derivedTurnsExecuted.get(p.id) ?? 0;
    const expectedFail = derivedConsecutiveFailures.get(p.id) ?? 0;

    if (p.turnsExecuted !== expectedExec) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' persisted turnsExecuted (${p.turnsExecuted}) does not match canonical completed turns (${expectedExec})`,
        false,
      );
    }
    if (p.consecutiveFailures !== expectedFail) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' persisted consecutiveFailures (${p.consecutiveFailures}) does not match derived trailing failures (${expectedFail})`,
        false,
      );
    }
    if (p.consecutiveFailures < 0 || !Number.isInteger(p.consecutiveFailures)) {
      throw new BridgeError(
        "persistence_corruption",
        `Run '${run.id}': participant '${p.id}' has invalid consecutiveFailures (${p.consecutiveFailures})`,
        false,
      );
    }

    const fromById = run.participantsById[p.id];
    if (fromById) {
      if (fromById.turnsExecuted !== expectedExec) {
        throw new BridgeError(
          "persistence_corruption",
          `Run '${run.id}': participant '${p.id}' in participantsById turnsExecuted (${fromById.turnsExecuted}) does not match canonical completed turns (${expectedExec})`,
          false,
        );
      }
      if (fromById.consecutiveFailures !== expectedFail) {
        throw new BridgeError(
          "persistence_corruption",
          `Run '${run.id}': participant '${p.id}' in participantsById consecutiveFailures (${fromById.consecutiveFailures}) does not match derived trailing failures (${expectedFail})`,
          false,
        );
      }
    }
  }

  // 8. Replay requirement check (Item 31)
  let interruptedTurnReplayRequired = false;
  let interruptedParticipantId: string | undefined = undefined;

  if (seqIdx < numRoles) {
    const currentParticipantId = run.participantIds[seqIdx]!;
    const participantTurns = sortedTurns.filter((t) => t.participantId === currentParticipantId);
    const lastTurn = participantTurns.length > 0 ? participantTurns[participantTurns.length - 1] : undefined;
    if (lastTurn && lastTurn.status === "failed" && lastTurn.error?.code === "daemon_restarted") {
      interruptedTurnReplayRequired = true;
      interruptedParticipantId = currentParticipantId;
    }
  }

  // Reconstruct priorTurns from canonical messages
  const priorTurns = collaborationMessagesToPriorTurns(sortedMessages);

  return {
    round,
    sequenceIndex: seqIdx,
    nextTurnIndex: sortedTurns.length,
    nextMessageSequenceIndex: sortedMessages.length,
    priorTurns,
    interruptedTurnReplayRequired,
    interruptedParticipantId,
  };
}


