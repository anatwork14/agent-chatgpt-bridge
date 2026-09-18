import type { AuditStore } from "../persistence/audit-store";
import {
  P5_DEFAULT_BUDGET,
  type CollaborationDagBudget,
  type CollaborationDagDefinition,
  type CollaborationDagExecutionPlan,
  type CollaborationDagFailurePolicy,
  type CollaborationDagPlannedNode,
} from "./collaboration-dag";
import {
  planCollaborationDag,
  validateCollaborationDagBudget,
  CollaborationDagValidationError,
} from "./collaboration-dag-validation";
import { runBoundedCollaborationDag } from "./collaboration-dag-scheduler";
import { assembleCollaborationDagInput } from "./collaboration-dag-provenance";
import type { CollaborationDagPersistence } from "./collaboration-dag-persistence";
import {
  emitCollaborationDagAuditEvent,
  type CollaborationDagAuditEventType,
  type CollaborationDagAuditPayloadMap,
} from "./collaboration-dag-audit";
import type {
  CollaborationConfig,
  CollaborationTurnRecord,
  ParticipantRecord,
  RoleBasedCollaborationRun,
  RoleBasedCollaborationRunStatus,
} from "./collaboration-domain";
import {
  isRoleBasedRunTerminalStatus,
  normalizeCancellationReason,
  requireValidStartedAt,
} from "./collaboration-domain";
import type {
  ActiveCollaborationDagRunControl,
  CollaborationDagExecutionOptions,
  CollaborationDagExecutionResult,
  CollaborationDagRecoveryReport,
  CollaborationDagResumeOptions,
  ParticipantRuntime,
  PreparedRoleParticipants,
} from "./collaboration-runtime";
import type { AgentDecision, AgentTurnInput } from "./domain";
import {
  assertMessageWithinSizeBound,
  computeCollaborationMessageHash,
  normalizeCanonicalText,
  type CollaborationMessageRecord,
} from "./collaboration-transcript";
import {
  generateCollaborationMessageId,
  generateCollaborationTurnId,
  generateRunId,
} from "./ids";
import { BridgeError } from "./errors";
import { deriveCollaborationDagPersistedState } from "./collaboration-dag-recovery";
import type { PersistedParticipant } from "./collaboration-persistence";

function retryableError(error: unknown): boolean {
  if (error instanceof BridgeError) return error.retryable;
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return false;
}

function errorCode(error: unknown): string {
  if (error instanceof BridgeError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "collaboration_dag_node_timeout";
  return "agent_adapter_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CollaborationDagController {
  private readonly activeRuns = new Map<string, ActiveCollaborationDagRunControl>();
  private readonly settlements = new Map<string, Promise<CollaborationDagExecutionResult>>();
  private readonly resumingRuns = new Set<string>();

  constructor(
    private readonly persistence: CollaborationDagPersistence,
    private readonly auditStore: AuditStore,
  ) {}

  private emit<T extends CollaborationDagAuditEventType>(params: {
    readonly eventType: T;
    readonly runId: string;
    readonly sessionId: string;
    readonly turnId?: string;
    readonly createdAt?: string;
    readonly payload: CollaborationDagAuditPayloadMap[T];
  }): void {
    emitCollaborationDagAuditEvent(this.auditStore, params);
  }

  async start(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    graph: CollaborationDagDefinition,
    options?: CollaborationDagExecutionOptions,
  ): Promise<RoleBasedCollaborationRun> {
    const clock = options?.clock ?? (() => new Date().toISOString());
    const runIdFactory = options?.runIdFactory ?? generateRunId;
    const failurePolicy: CollaborationDagFailurePolicy = options?.failurePolicy ?? "fail_fast";

    const budget: CollaborationDagBudget = {
      ...P5_DEFAULT_BUDGET,
      ...(config.budget ?? {}),
      ...(options?.budget ?? {}),
    };
    const budgetIssues = validateCollaborationDagBudget(budget);
    if (budgetIssues.length > 0) {
      throw new CollaborationDagValidationError(budgetIssues);
    }

    if (prepared.plans.length === 0) {
      throw new BridgeError(
        "invalid_collaboration_dag",
        "P5 DAG execution requires at least one prepared participant",
        false,
      );
    }
    if (prepared.plans.length > budget.maxParticipants) {
      throw new BridgeError(
        "collaboration_budget_exceeded",
        `Prepared participant count ${prepared.plans.length} exceeds maxParticipants ${budget.maxParticipants}`,
        false,
      );
    }

    const participantIds = prepared.plans.map(item => item.participantId);
    const participantIdSet = new Set(participantIds);
    if (participantIdSet.size !== participantIds.length) {
      throw new BridgeError(
        "duplicate_participant_id",
        "P5 DAG prepared participants contain duplicate IDs",
        false,
      );
    }

    const plan = planCollaborationDag(graph, {
      knownParticipantIds: participantIdSet,
      budget,
    });

    for (const node of Object.values(plan.nodesById)) {
      const runtime = prepared.runtimes.find(item => item.participantId === node.participantId);
      const assignment = prepared.plans.find(item => item.participantId === node.participantId);
      const record = prepared.records.participantsById[node.participantId];
      if (!runtime || !assignment || !record) {
        throw new BridgeError(
          "invalid_collaboration_dag",
          `DAG node '${node.id}' has incomplete participant binding '${node.participantId}'`,
          false,
        );
      }
      if (runtime.roleId !== assignment.roleId || record.roleId !== assignment.roleId) {
        throw new BridgeError(
          "invalid_collaboration_dag",
          `DAG participant binding '${node.participantId}' has inconsistent role provenance`,
          false,
        );
      }
    }

    const runId = runIdFactory();
    const nowIso = clock();
    const participantsById: Record<string, ParticipantRecord> = {};
    for (const participantId of prepared.records.participantIds) {
      const record = prepared.records.participantsById[participantId];
      if (!record) {
        throw new BridgeError(
          "invalid_collaboration_dag",
          `Missing prepared participant record '${participantId}'`,
          false,
        );
      }
      participantsById[participantId] = { ...record };
    }

    const initialRun: RoleBasedCollaborationRun = {
      id: runId,
      sessionId,
      objective: config.objective,
      status: "running",
      round: 0,
      budget,
      policy: config.policy,
      participantIds: [...prepared.records.participantIds],
      participantsById,
      turnHistory: [],
      createdAt: nowIso,
      startedAt: nowIso,
    };

    try {
      this.persistence.createInitialDagRun({
        run: initialRun,
        plans: prepared.plans,
        graph,
        plan,
        failurePolicy,
      });
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        "collaboration_persistence_failed",
        `Failed to persist initial DAG run: ${errorMessage(error)}`,
        false,
      );
    }

    this.emit({
      eventType: "collaboration.dag.validated",
      runId,
      sessionId,
      createdAt: nowIso,
      payload: {
        schemaVersion: 1,
        nodeCount: plan.nodeIds.length,
        edgeCount: plan.edgeCount,
        rootCount: plan.rootNodeIds.length,
        sinkCount: plan.sinkNodeIds.length,
      },
    });
    this.emit({
      eventType: "collaboration.dag.started",
      runId,
      sessionId,
      createdAt: nowIso,
      payload: {
        schemaVersion: 1,
        nodeCount: plan.nodeIds.length,
        edgeCount: plan.edgeCount,
        participantCount: participantIds.length,
        maxParallelTurns: budget.maxParallelTurns,
        failurePolicy,
      },
    });

    const rootAbortController = new AbortController();
    const externalAbort = () => rootAbortController.abort(options?.signal?.reason);
    if (options?.signal?.aborted) {
      rootAbortController.abort(options.signal.reason);
    } else {
      options?.signal?.addEventListener("abort", externalAbort, { once: true });
    }

    const control: ActiveCollaborationDagRunControl = {
      runId,
      rootAbortController,
      persistence: this.persistence,
      attemptsStarted: 0,
    };
    this.activeRuns.set(runId, control);

    const settlement = this.executeLoop(
      initialRun,
      prepared,
      plan,
      control,
      options,
    )
      .catch(async error => {
        if (error instanceof BridgeError && error.code === "collaboration_persistence_failed") {
          throw error;
        }
        return this.settleFailure(initialRun, plan, control, error, clock);
      })
      .finally(() => {
        options?.signal?.removeEventListener("abort", externalAbort);
        this.activeRuns.delete(runId);
        this.settlements.delete(runId);
      });

    this.settlements.set(runId, settlement);
    return initialRun;
  }

  async execute(
    sessionId: string,
    config: CollaborationConfig,
    prepared: PreparedRoleParticipants,
    graph: CollaborationDagDefinition,
    options?: CollaborationDagExecutionOptions,
  ): Promise<CollaborationDagExecutionResult> {
    const run = await this.start(sessionId, config, prepared, graph, options);
    return this.waitForRun(run.id);
  }

  async waitForRun(runId: string): Promise<CollaborationDagExecutionResult> {
    const settlement = this.settlements.get(runId);
    if (settlement) return settlement;

    const run = this.persistence.getRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `DAG run '${runId}' not found`, false);
    }
    return {
      run,
      nodes: this.persistence.getNodes(runId),
    };
  }

  getRun(runId: string): RoleBasedCollaborationRun | null {
    return this.persistence.getRun(runId);
  }

  async cancelRun(
    runId: string,
    reason = "Collaboration DAG run was cancelled",
  ): Promise<boolean> {
    const normalized = normalizeCancellationReason(reason);
    const current = this.persistence.getRun(runId);
    if (!current || isRoleBasedRunTerminalStatus(current.status)) return false;

    const control = this.activeRuns.get(runId);
    if (control && !control.rootAbortController.signal.aborted) {
      control.rootAbortController.abort(new DOMException(normalized, "AbortError"));
      const settlement = this.settlements.get(runId);
      if (settlement) await settlement;
      return this.persistence.getRun(runId)?.status === "cancelled";
    }

    const completedAt = new Date().toISOString();
    for (const node of this.persistence.getNodes(runId)) {
      if (node.status === "completed" || node.status === "failed" || node.status === "skipped" || node.status === "cancelled") {
        continue;
      }
      this.persistence.markNodeTerminal({
        runId,
        nodeId: node.id,
        status: "cancelled",
        completedAt,
      });
    }
    this.persistence.finalizeRun(runId, {
      status: "cancelled",
      finalSummary: normalized,
      completedAt,
      activeParticipantId: null,
    });
    return true;
  }

  async cancelAllRuns(reason = "Bridge shutting down"): Promise<number> {
    const ids = [...this.activeRuns.keys()];
    const results = await Promise.all(ids.map(id => this.cancelRun(id, reason)));
    return results.filter(Boolean).length;
  }

  async waitForIdle(): Promise<void> {
    while (this.settlements.size > 0) {
      await Promise.allSettled([...this.settlements.values()]);
    }
  }

  private async executeLoop(
    initialRun: RoleBasedCollaborationRun,
    prepared: PreparedRoleParticipants,
    plan: CollaborationDagExecutionPlan,
    control: ActiveCollaborationDagRunControl,
    options?: CollaborationDagExecutionOptions,
    initialStatusesByNode?: Readonly<Record<string, import("./collaboration-dag-scheduler").CollaborationDagSchedulerNodeStatus>>,
  ): Promise<CollaborationDagExecutionResult> {
    const clock = options?.clock ?? (() => new Date().toISOString());
    const now = options?.now ?? (() => Date.now());
    const startedAtMs = requireValidStartedAt(initialRun, now());
    const initialized = new Set<string>();
    const runtimeByParticipant = new Map<string, ParticipantRuntime>(
      prepared.runtimes.map(runtime => [runtime.participantId, runtime]),
    );
    const assignmentByParticipant = new Map(
      prepared.plans.map(item => [item.participantId, item]),
    );

    try {
      const failurePolicy: CollaborationDagFailurePolicy = options?.failurePolicy ?? "fail_fast";
      const schedulerResult = await runBoundedCollaborationDag<CollaborationMessageRecord>(plan, {
        maxParallelTurns: initialRun.budget.maxParallelTurns,
        failurePolicy,
        signal: control.rootAbortController.signal,
        initialStatusesByNode,
        onTransition: transition => {
          const node = plan.nodesById[transition.nodeId]!;
          if (transition.to === "ready") {
            this.persistence.markNodeReady(initialRun.id, transition.nodeId);
            this.emit({
              eventType: "collaboration.dag.node.ready",
              runId: initialRun.id,
              sessionId: initialRun.sessionId,
              payload: {
                schemaVersion: 1,
                nodeId: node.id,
                participantId: node.participantId,
                declarationIndex: node.declarationIndex,
                dependencyCount: node.dependsOn.length,
              },
            });
            return;
          }

          if (transition.to === "skipped") {
            const assignment = assignmentByParticipant.get(node.participantId);
            if (!assignment) {
              throw new BridgeError(
                "invalid_collaboration_dag",
                `Missing role binding for skipped DAG participant '${node.participantId}'`,
                false,
              );
            }
            const completedAt = clock();
            this.persistence.markNodeTerminal({
              runId: initialRun.id,
              nodeId: node.id,
              status: "skipped",
              completedAt,
            });
            this.emit({
              eventType: "collaboration.dag.node.skipped",
              runId: initialRun.id,
              sessionId: initialRun.sessionId,
              createdAt: completedAt,
              payload: {
                schemaVersion: 1,
                nodeId: node.id,
                participantId: node.participantId,
                roleId: assignment.roleId,
              },
            });
          }
        },
        executeNode: async (node, context) => {
          const runtime = runtimeByParticipant.get(node.participantId);
          const assignment = assignmentByParticipant.get(node.participantId);
          if (!runtime || !assignment) {
            throw new BridgeError(
              "invalid_collaboration_dag",
              `Missing runtime binding for participant '${node.participantId}'`,
              false,
            );
          }

          return await this.executeNodeWithRetries({
            initialRun,
            node,
            plan,
            runtime,
            assignment,
            control,
            initialized,
            signal: context.signal,
            startedAtMs,
            clock,
            now,
            options,
          });
        },
      });

      const messagesByNode = this.persistence.getMessagesByNode(initialRun.id);

      if (failurePolicy === "skip_dependents" && schedulerResult.failedNodeIds.length > 0) {
        const completedTerminalNodeIds = plan.nodeIds.filter(nodeId => {
          const node = plan.nodesById[nodeId]!;
          return node.terminal && messagesByNode[nodeId] !== undefined;
        });
        if (completedTerminalNodeIds.length === 0) {
          throw new BridgeError(
            "collaboration_dag_terminal_unreachable",
            "All declared terminal DAG paths became unreachable after branch failure",
            false,
          );
        }
      }

      let finalSummary = "Collaboration DAG completed";
      const preferredSinks = [
        ...plan.nodeIds.filter(nodeId => plan.nodesById[nodeId]!.terminal),
        ...plan.sinkNodeIds,
      ].reverse();
      for (const sinkId of preferredSinks) {
        const message = messagesByNode[sinkId];
        if (message) {
          finalSummary = message.content;
          break;
        }
      }

      const completedAt = clock();
      this.persistence.finalizeRun(initialRun.id, {
        status: "completed",
        round: plan.nodeIds.length,
        finalSummary,
        completedAt,
        activeParticipantId: null,
      });

      const canonicalRun = this.persistence.getRun(initialRun.id);
      if (!canonicalRun) {
        throw new BridgeError("persistence_corruption", "Completed DAG run disappeared from persistence", false);
      }
      const nodes = this.persistence.getNodes(initialRun.id);
      this.emit({
        eventType: "collaboration.dag.completed",
        runId: initialRun.id,
        sessionId: initialRun.sessionId,
        createdAt: completedAt,
        payload: {
          schemaVersion: 1,
          nodeCount: nodes.length,
          totalAttempts: control.attemptsStarted,
        },
      });
      return { run: canonicalRun, nodes };
    } finally {
      await Promise.allSettled(
        prepared.runtimes.map(async runtime => {
          if (runtime.adapter.close) await runtime.adapter.close();
        }),
      );
    }
  }

  private async executeNodeWithRetries(params: {
    readonly initialRun: RoleBasedCollaborationRun;
    readonly node: CollaborationDagPlannedNode;
    readonly plan: CollaborationDagExecutionPlan;
    readonly runtime: ParticipantRuntime;
    readonly assignment: PreparedRoleParticipants["plans"][number];
    readonly control: ActiveCollaborationDagRunControl;
    readonly initialized: Set<string>;
    readonly signal: AbortSignal;
    readonly startedAtMs: number;
    readonly clock: () => string;
    readonly now: () => number;
    readonly options?: CollaborationDagExecutionOptions;
  }): Promise<CollaborationMessageRecord> {
    const {
      initialRun,
      node,
      plan,
      runtime,
      assignment,
      control,
      initialized,
      signal,
      startedAtMs,
      clock,
      now,
      options,
    } = params;

    const maxAttempts = node.retryLimit + 1;
    const turnIdFactory = options?.turnIdFactory ?? generateCollaborationTurnId;
    const messageIdFactory = options?.messageIdFactory ?? generateCollaborationMessageId;

    const persistedNode = this.persistence
      .getNodes(initialRun.id)
      .find(item => item.id === node.id);
    if (!persistedNode) {
      throw new BridgeError(
        "persistence_corruption",
        `DAG node '${node.id}' disappeared before execution`,
        false,
      );
    }
    let firstAttempt = 1;
    if (persistedNode.attempt > 0) {
      firstAttempt =
        persistedNode.status === "ready" && persistedNode.error?.code === "daemon_restarted"
          ? persistedNode.attempt
          : persistedNode.attempt + 1;
    }
    if (firstAttempt > maxAttempts) {
      throw new BridgeError(
        "collaboration_dag_node_failed",
        `DAG node '${node.id}' has no bounded attempts remaining`,
        false,
      );
    }

    for (let attempt = firstAttempt; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        throw new BridgeError("collaboration_dag_cancelled", "DAG execution was cancelled", false);
      }

      if (control.attemptsStarted >= initialRun.budget.maxTurns) {
        throw new BridgeError(
          "collaboration_dag_budget_exhausted",
          `DAG attempt budget exhausted at ${initialRun.budget.maxTurns} turns`,
          false,
        );
      }

      const elapsed = now() - startedAtMs;
      const remainingWallClockMs = initialRun.budget.maxWallClockMs - elapsed;
      if (remainingWallClockMs <= 0) {
        throw new BridgeError(
          "collaboration_dag_timed_out",
          "DAG run wall-clock budget exhausted",
          false,
        );
      }

      control.attemptsStarted++;
      const turnIndex =
        node.declarationIndex * (initialRun.budget.maxRetriesPerParticipant + 1) +
        (attempt - 1);
      const turnId = turnIdFactory();
      const attemptStartedAt = clock();
      const attemptStartedMs = now();

      const messagesByNodeId = this.persistence.getMessagesByNode(initialRun.id);
      const assembled = assembleCollaborationDagInput({
        runId: initialRun.id,
        nodeId: node.id,
        plan,
        messagesByNodeId,
        assembledAt: attemptStartedAt,
      });

      const currentRun = this.persistence.getRun(initialRun.id);
      const previousParticipant = currentRun?.participantsById[node.participantId];
      if (!previousParticipant) {
        throw new BridgeError(
          "persistence_corruption",
          `Missing persisted participant '${node.participantId}'`,
          false,
        );
      }
      const activeParticipant: ParticipantRecord = {
        ...previousParticipant,
        status: "active",
        lastActiveAt: attemptStartedAt,
      };
      this.persistence.markNodeRunningTransaction({
        runId: initialRun.id,
        nodeId: node.id,
        participant: activeParticipant,
        attempt,
        startedAt: attemptStartedAt,
      });

      let completionCommitted = false;

      try {
        this.emit({
          eventType: "collaboration.dag.node.started",
          runId: initialRun.id,
          sessionId: initialRun.sessionId,
          turnId,
          createdAt: attemptStartedAt,
          payload: {
            schemaVersion: 1,
            nodeId: node.id,
            participantId: node.participantId,
            roleId: assignment.roleId,
            attempt,
            turnIndex,
          },
        });
        if (!initialized.has(node.participantId)) {
          if (runtime.adapter.initialize) {
            await runtime.adapter.initialize({
              runId: initialRun.id,
              objective: initialRun.objective,
              cwd: assignment.config.cwd,
            });
          }
          initialized.add(node.participantId);
        }

        const turnInput: AgentTurnInput = {
          runId: initialRun.id,
          objective: initialRun.objective,
          round: node.topologicalLevel,
          workspace: assignment.config.cwd ? { cwd: assignment.config.cwd } : undefined,
          collaboration: {
            participantId: node.participantId,
            roleId: assignment.roleId,
            roleName: assignment.role.name,
            systemInstructions: assignment.role.systemInstructions,
            sequenceIndex: assignment.sequenceIndex,
            priorTurns: assembled.priorTurns,
            dag: {
              nodeId: node.id,
              dependencyNodeIds: assembled.provenance.predecessorNodeIds,
              predecessorMessageIds: assembled.provenance.predecessorMessageIds,
              attempt,
            },
          },
        };

        const timeoutMs = Math.min(
          remainingWallClockMs,
          node.timeoutMs ?? remainingWallClockMs,
        );
        const decision = await this.nextWithTimeout(
          runtime,
          turnInput,
          signal,
          timeoutMs,
        );

        if (decision.type === "error") {
          throw new BridgeError(
            "agent_reported_error",
            decision.message,
            decision.retryable,
          );
        }
        if (decision.type === "pause") {
          throw new BridgeError(
            "collaboration_dag_pause_unsupported",
            "Pause decisions are not supported inside a P5 DAG node",
            false,
          );
        }
        if (decision.type === "done" && !node.terminal) {
          throw new BridgeError(
            "unauthorized_terminal_decision",
            `Non-terminal DAG node '${node.id}' attempted an authoritative done decision`,
            false,
          );
        }

        const decisionType: "message" | "done" = decision.type;
        const rawContent = decision.type === "message" ? decision.content : decision.summary;
        const content = normalizeCanonicalText(rawContent);
        assertMessageWithinSizeBound(content);

        const completedAt = clock();
        const completedMs = now();
        const message: CollaborationMessageRecord = {
          id: messageIdFactory(),
          runId: initialRun.id,
          turnId,
          sequenceIndex: node.declarationIndex,
          senderParticipantId: node.participantId,
          senderRoleId: assignment.roleId,
          decisionType,
          content,
          contentHash: computeCollaborationMessageHash({
            runId: initialRun.id,
            turnId,
            participantId: node.participantId,
            roleId: assignment.roleId,
            decisionType,
            content,
          }),
          createdAt: completedAt,
        };

        const turn: CollaborationTurnRecord = {
          id: turnId,
          runId: initialRun.id,
          round: node.topologicalLevel,
          turnIndex,
          participantId: node.participantId,
          roleId: assignment.roleId,
          status: "completed",
          inputSummary: `DAG node ${node.id} attempt ${attempt}`,
          decision,
          startedAt: attemptStartedAt,
          completedAt,
          durationMs: Math.max(0, completedMs - attemptStartedMs),
        };
        const participant: ParticipantRecord = {
          ...activeParticipant,
          status: "idle",
          turnsExecuted: activeParticipant.turnsExecuted + 1,
          consecutiveFailures: 0,
          lastActiveAt: completedAt,
        };

        this.persistence.recordNodeAttemptTransaction({
          nodeId: node.id,
          turn,
          message,
          provenance: {
            ...assembled.provenance,
            runId: initialRun.id,
            attempt,
            turnId,
          },
          participant,
          nodeOutcome: {
            status: "completed",
            completedAt,
            outputMessageId: message.id,
          },
        });
        completionCommitted = true;

        this.emit({
          eventType: "collaboration.dag.node.completed",
          runId: initialRun.id,
          sessionId: initialRun.sessionId,
          turnId,
          createdAt: completedAt,
          payload: {
            schemaVersion: 1,
            nodeId: node.id,
            participantId: node.participantId,
            roleId: assignment.roleId,
            attempt,
            decisionType,
            durationMs: turn.durationMs ?? 0,
          },
        });
        return message;
      } catch (error) {
        if (completionCommitted) {
          throw error;
        }

        const cancelled = signal.aborted ||
          (error instanceof BridgeError && error.code === "collaboration_dag_cancelled");
        const retryable = !cancelled && retryableError(error);
        const canRetry = retryable && attempt < maxAttempts;
        const completedAt = clock();
        const completedMs = now();
        const code = cancelled ? "collaboration_dag_cancelled" : errorCode(error);

        const turn: CollaborationTurnRecord = {
          id: turnId,
          runId: initialRun.id,
          round: node.topologicalLevel,
          turnIndex,
          participantId: node.participantId,
          roleId: assignment.roleId,
          status: cancelled ? "cancelled" : "failed",
          inputSummary: `DAG node ${node.id} attempt ${attempt}`,
          error: {
            code,
            message: cancelled ? "DAG node cancelled" : errorMessage(error),
            retryable: canRetry,
          },
          startedAt: attemptStartedAt,
          completedAt,
          durationMs: Math.max(0, completedMs - attemptStartedMs),
        };
        const participant: ParticipantRecord = {
          ...activeParticipant,
          status: cancelled ? "cancelled" : canRetry ? "idle" : "failed",
          turnsExecuted: activeParticipant.turnsExecuted + 1,
          consecutiveFailures: activeParticipant.consecutiveFailures + 1,
          lastActiveAt: completedAt,
        };

        this.persistence.recordNodeAttemptTransaction({
          nodeId: node.id,
          turn,
          provenance: {
            ...assembled.provenance,
            runId: initialRun.id,
            attempt,
            turnId,
          },
          participant,
          nodeOutcome: {
            status: cancelled ? "cancelled" : canRetry ? "ready" : "failed",
            completedAt: cancelled || !canRetry ? completedAt : undefined,
            error: {
              code,
              message: cancelled ? "DAG node cancelled" : errorMessage(error),
              retryable: canRetry,
            },
          },
        });

        if (cancelled) {
          this.emit({
            eventType: "collaboration.dag.node.cancelled",
            runId: initialRun.id,
            sessionId: initialRun.sessionId,
            turnId,
            createdAt: completedAt,
            payload: {
              schemaVersion: 1,
              nodeId: node.id,
              participantId: node.participantId,
              roleId: assignment.roleId,
              attempt,
            },
          });
          throw new BridgeError("collaboration_dag_cancelled", "DAG node cancelled", false);
        }

        if (canRetry) {
          this.emit({
            eventType: "collaboration.dag.node.retrying",
            runId: initialRun.id,
            sessionId: initialRun.sessionId,
            turnId,
            createdAt: completedAt,
            payload: {
              schemaVersion: 1,
              nodeId: node.id,
              participantId: node.participantId,
              roleId: assignment.roleId,
              attempt,
              maxAttempts,
              errorCode: code,
            },
          });

          if (runtime.recreateAdapter) {
            try {
              await runtime.adapter.close?.();
            } catch {
              // Retry remains bounded and fail-closed even if cleanup reports an error.
            }
            runtime.adapter = runtime.recreateAdapter();
            initialized.delete(node.participantId);
          }
          continue;
        }

        this.emit({
          eventType: "collaboration.dag.node.failed",
          runId: initialRun.id,
          sessionId: initialRun.sessionId,
          turnId,
          createdAt: completedAt,
          payload: {
            schemaVersion: 1,
            nodeId: node.id,
            participantId: node.participantId,
            roleId: assignment.roleId,
            attempt,
            errorCode: code,
            retryable: false,
          },
        });
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(code, errorMessage(error), false);
      }
    }

    throw new BridgeError(
      "collaboration_dag_node_failed",
      `DAG node '${node.id}' exhausted attempts`,
      false,
    );
  }

  private async nextWithTimeout(
    runtime: ParticipantRuntime,
    input: AgentTurnInput,
    parentSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<AgentDecision> {
    const local = new AbortController();
    const onParentAbort = () => local.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      local.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError = new Error(`DAG node exceeded timeout of ${timeoutMs}ms`);
        timeoutError.name = "TimeoutError";
        local.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        runtime.adapter.next(input, { signal: local.signal }),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  private async settleFailure(
    initialRun: RoleBasedCollaborationRun,
    plan: CollaborationDagExecutionPlan,
    control: ActiveCollaborationDagRunControl,
    error: unknown,
    clock: () => string,
  ): Promise<CollaborationDagExecutionResult> {
    const completedAt = clock();
    const code = errorCode(error);
    let status: RoleBasedCollaborationRunStatus = "failed";
    if (
      control.rootAbortController.signal.aborted ||
      (error instanceof BridgeError && error.code === "collaboration_dag_cancelled")
    ) {
      status = "cancelled";
    } else if (error instanceof BridgeError && error.code === "collaboration_dag_budget_exhausted") {
      status = "budget_exhausted";
    } else if (error instanceof BridgeError && error.code === "collaboration_dag_timed_out") {
      status = "timed_out";
    }

    const nodesBefore = this.persistence.getNodes(initialRun.id);
    for (const node of nodesBefore) {
      if (
        node.status === "completed" ||
        node.status === "failed" ||
        node.status === "skipped" ||
        node.status === "cancelled"
      ) {
        continue;
      }
      this.persistence.markNodeTerminal({
        runId: initialRun.id,
        nodeId: node.id,
        status: "cancelled",
        completedAt,
      });
    }

    const currentRun = this.persistence.getRun(initialRun.id);
    if (currentRun && !isRoleBasedRunTerminalStatus(currentRun.status)) {
      this.persistence.finalizeRun(initialRun.id, {
        status,
        finalSummary: errorMessage(error),
        completedAt,
        activeParticipantId: null,
      });
    }

    const canonicalRun = this.persistence.getRun(initialRun.id);
    if (!canonicalRun) {
      throw new BridgeError("persistence_corruption", "Failed DAG run disappeared from persistence", false);
    }
    const nodes = this.persistence.getNodes(initialRun.id);
    const failedNodeCount = nodes.filter(node => node.status === "failed").length;
    const cancelledNodeCount = nodes.filter(node => node.status === "cancelled").length;

    if (status === "cancelled") {
      this.emit({
        eventType: "collaboration.dag.cancelled",
        runId: initialRun.id,
        sessionId: initialRun.sessionId,
        createdAt: completedAt,
        payload: {
          schemaVersion: 1,
          nodeCount: nodes.length,
          totalAttempts: control.attemptsStarted,
          cancelledNodeCount,
        },
      });
    } else {
      this.emit({
        eventType: "collaboration.dag.failed",
        runId: initialRun.id,
        sessionId: initialRun.sessionId,
        createdAt: completedAt,
        payload: {
          schemaVersion: 1,
          nodeCount: nodes.length,
          totalAttempts: control.attemptsStarted,
          failedNodeCount,
        },
      });
    }

    return { run: canonicalRun, nodes };
  }
}
