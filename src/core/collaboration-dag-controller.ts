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

  private loadValidatedState(runId: string) {
    const run = this.persistence.getRun(runId);
    if (!run) {
      throw new BridgeError("run_not_found", `DAG run '${runId}' not found`, false);
    }
    const metadata = this.persistence.getMetadata(runId);
    if (!metadata) {
      throw new BridgeError(
        "persistence_corruption",
        `Role-based run '${runId}' is missing P5 DAG metadata`,
        false,
      );
    }
    const nodes = this.persistence.getNodes(runId);
    const inputs = this.persistence.getInputs(runId);
    const messagesByNode = this.persistence.getMessagesByNode(runId);
    const state = deriveCollaborationDagPersistedState({
      run,
      metadata,
      nodes,
      inputs,
      messagesByNode,
    });
    return { run, metadata, nodes, inputs, messagesByNode, state };
  }

  private preferredFinalSummary(
    plan: CollaborationDagExecutionPlan,
    messagesByNode: Readonly<Record<string, CollaborationMessageRecord>>,
  ): string {
    const preferred = [
      ...plan.nodeIds.filter(nodeId => plan.nodesById[nodeId]!.terminal),
      ...plan.sinkNodeIds,
    ].reverse();
    for (const nodeId of preferred) {
      const message = messagesByNode[nodeId];
      if (message) return message.content;
    }
    return "Collaboration DAG completed";
  }

  private cancelUnfinishedNodes(
    runId: string,
    nodes: readonly import("./collaboration-dag").CollaborationDagNodeRecord[],
    completedAt: string,
  ): void {
    for (const node of nodes) {
      if (
        node.status === "completed" ||
        node.status === "failed" ||
        node.status === "skipped" ||
        node.status === "cancelled"
      ) {
        continue;
      }
      this.persistence.markNodeTerminal({
        runId,
        nodeId: node.id,
        status: "cancelled",
        completedAt,
      });
    }
  }

  private propagatePersistedSkipDependents(
    run: RoleBasedCollaborationRun,
    metadata: import("./collaboration-dag").CollaborationDagRunMetadata,
    completedAt: string,
  ): number {
    if (metadata.failurePolicy !== "skip_dependents") return 0;

    const snapshot = this.loadValidatedState(run.id);
    const statuses = new Map(snapshot.nodes.map(node => [node.id, node.status]));
    const skipped = new Set<string>();

    for (const failedNode of snapshot.nodes.filter(node => node.status === "failed")) {
      const queue = [...snapshot.state.plan.nodesById[failedNode.id]!.dependents];
      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (skipped.has(nodeId)) continue;
        skipped.add(nodeId);
        const status = statuses.get(nodeId);
        if (status === "pending" || status === "ready") {
          const persisted = snapshot.nodes.find(node => node.id === nodeId)!;
          this.persistence.markNodeTerminal({
            runId: run.id,
            nodeId,
            status: "skipped",
            completedAt,
          });
          statuses.set(nodeId, "skipped");
          this.emit({
            eventType: "collaboration.dag.node.skipped",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: completedAt,
            payload: {
              schemaVersion: 1,
              nodeId,
              participantId: persisted.participantId,
              roleId: persisted.roleId,
            },
          });
        }
        for (const childId of snapshot.state.plan.nodesById[nodeId]!.dependents) {
          queue.push(childId);
        }
      }
    }

    return [...statuses.values()].filter(status => status === "skipped").length;
  }

  recoverRunningRuns(options?: {
    readonly now?: () => number;
    readonly clock?: () => string;
  }): CollaborationDagRecoveryReport {
    const now = options?.now ?? (() => Date.now());
    const clock = options?.clock ?? (() => new Date().toISOString());
    const orphaned = this.persistence.listRunsByStatuses(["running"]);
    let pausedAtSafeBoundary = 0;
    let interruptedNodesReconciled = 0;
    let completedAtRecovery = 0;
    let terminalAtRecovery = 0;

    for (const run of orphaned) {
      if (this.activeRuns.has(run.id)) continue;

      try {
        const before = this.loadValidatedState(run.id);
        const interruptedBefore = before.state.interruptedNodeIds.length;
        const activeParticipants = new Set<string>();

        for (const nodeId of before.state.interruptedNodeIds) {
          const node = before.nodes.find(item => item.id === nodeId)!;
          if (activeParticipants.has(node.participantId)) {
            throw new BridgeError(
              "persistence_corruption",
              `Multiple running DAG nodes share participant '${node.participantId}'`,
              false,
            );
          }
          activeParticipants.add(node.participantId);

          const participant = run.participantsById[node.participantId];
          if (!participant || participant.status !== "active") {
            throw new BridgeError(
              "persistence_corruption",
              `Running DAG node '${node.id}' does not have an active participant snapshot`,
              false,
            );
          }
          this.persistence.reconcileInterruptedNode({
            runId: run.id,
            nodeId: node.id,
            participant: {
              ...participant,
              status: "idle",
            },
            recoveredAt: clock(),
          });
          interruptedNodesReconciled++;
        }

        const recoveredAt = clock();
        this.propagatePersistedSkipDependents(run, before.metadata, recoveredAt);
        let current = this.loadValidatedState(run.id);
        const nodes = current.nodes;
        const hasFailed = nodes.some(node => node.status === "failed");
        const hasCancelled = nodes.some(node => node.status === "cancelled");

        if (hasCancelled || (current.metadata.failurePolicy === "fail_fast" && hasFailed)) {
          this.cancelUnfinishedNodes(run.id, nodes, recoveredAt);
          const status: RoleBasedCollaborationRunStatus = hasCancelled ? "cancelled" : "failed";
          this.persistence.finalizeRun(run.id, {
            status,
            activeParticipantId: null,
            completedAt: recoveredAt,
            finalSummary: hasCancelled
              ? "Recovered a partially cancelled DAG run"
              : "Recovered a fail-fast DAG run after node failure",
          });
          terminalAtRecovery++;
          this.emit({
            eventType: "collaboration.dag.recovered",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: recoveredAt,
            payload: {
              schemaVersion: 1,
              recoveryKind: interruptedBefore > 0 ? "interrupted_nodes" : "safe_boundary",
              interruptedNodeCount: interruptedBefore,
              outcomeStatus: status,
            },
          });
          continue;
        }

        current = this.loadValidatedState(run.id);
        const allTerminal = current.nodes.every(node =>
          node.status === "completed" ||
          node.status === "failed" ||
          node.status === "skipped" ||
          node.status === "cancelled"
        );

        if (allTerminal) {
          const hasCompletedTerminal = current.state.completedTerminalNodeIds.length > 0;
          const hasAnyFailed = current.nodes.some(node => node.status === "failed");
          const hasAnyCancelled = current.nodes.some(node => node.status === "cancelled");
          let status: RoleBasedCollaborationRunStatus;
          if (hasAnyCancelled) status = "cancelled";
          else if (current.metadata.failurePolicy === "skip_dependents" && hasAnyFailed && !hasCompletedTerminal) {
            status = "failed";
          } else if (hasAnyFailed && current.metadata.failurePolicy === "fail_fast") {
            status = "failed";
          } else {
            status = "completed";
          }

          this.persistence.finalizeRun(run.id, {
            status,
            activeParticipantId: null,
            completedAt: recoveredAt,
            finalSummary:
              status === "completed"
                ? this.preferredFinalSummary(current.state.plan, current.messagesByNode)
                : "Recovered terminal DAG state",
          });
          if (status === "completed") completedAtRecovery++;
          else terminalAtRecovery++;
          this.emit({
            eventType: "collaboration.dag.recovered",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: recoveredAt,
            payload: {
              schemaVersion: 1,
              recoveryKind: interruptedBefore > 0 ? "interrupted_nodes" : "safe_boundary",
              interruptedNodeCount: interruptedBefore,
              outcomeStatus: status,
            },
          });
          continue;
        }

        const nowMs = now();
        const originMs = requireValidStartedAt(run, nowMs);
        if (nowMs - originMs >= run.budget.maxWallClockMs) {
          this.cancelUnfinishedNodes(run.id, current.nodes, recoveredAt);
          this.persistence.finalizeRun(run.id, {
            status: "timed_out",
            activeParticipantId: null,
            completedAt: recoveredAt,
            finalSummary: `Exceeded maximum wall-clock deadline (${run.budget.maxWallClockMs} ms)`,
          });
          terminalAtRecovery++;
          this.emit({
            eventType: "collaboration.dag.recovered",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: recoveredAt,
            payload: {
              schemaVersion: 1,
              recoveryKind: interruptedBefore > 0 ? "interrupted_nodes" : "safe_boundary",
              interruptedNodeCount: interruptedBefore,
              outcomeStatus: "timed_out",
            },
          });
          continue;
        }

        if (current.state.totalAttemptsStarted >= run.budget.maxTurns) {
          this.cancelUnfinishedNodes(run.id, current.nodes, recoveredAt);
          this.persistence.finalizeRun(run.id, {
            status: "budget_exhausted",
            activeParticipantId: null,
            completedAt: recoveredAt,
            finalSummary: `Exceeded maximum allowed turns (${run.budget.maxTurns})`,
          });
          terminalAtRecovery++;
          this.emit({
            eventType: "collaboration.dag.recovered",
            runId: run.id,
            sessionId: run.sessionId,
            createdAt: recoveredAt,
            payload: {
              schemaVersion: 1,
              recoveryKind: interruptedBefore > 0 ? "interrupted_nodes" : "safe_boundary",
              interruptedNodeCount: interruptedBefore,
              outcomeStatus: "budget_exhausted",
            },
          });
          continue;
        }

        this.persistence.finalizeRun(run.id, {
          status: "paused",
          activeParticipantId: null,
          completedAt: null,
          finalSummary: null,
        });
        if (interruptedBefore === 0) pausedAtSafeBoundary++;
        this.emit({
          eventType: "collaboration.dag.recovered",
          runId: run.id,
          sessionId: run.sessionId,
          createdAt: recoveredAt,
          payload: {
            schemaVersion: 1,
            recoveryKind: interruptedBefore > 0 ? "interrupted_nodes" : "safe_boundary",
            interruptedNodeCount: interruptedBefore,
            outcomeStatus: "paused",
          },
        });
      } catch (error) {
        throw new BridgeError(
          "collaboration_dag_recovery_failed",
          `Failed to recover DAG run '${run.id}': ${errorMessage(error)}`,
          false,
        );
      }
    }

    return {
      examined: orphaned.length,
      pausedAtSafeBoundary,
      interruptedNodesReconciled,
      completedAtRecovery,
      terminalAtRecovery,
      failedRunIds: [],
    };
  }

  prepareResume(
    runId: string,
    options?: CollaborationDagResumeOptions,
  ): readonly PersistedParticipant[] {
    if (this.activeRuns.has(runId) || this.resumingRuns.has(runId)) {
      throw new BridgeError("resume_in_progress", `DAG run '${runId}' is already active/resuming`, false);
    }

    const snapshot = this.loadValidatedState(runId);
    if (snapshot.run.status !== "paused") {
      throw new BridgeError(
        "invalid_state_transition",
        `Cannot resume DAG run '${runId}' with status '${snapshot.run.status}' (must be 'paused')`,
        false,
      );
    }
    if (snapshot.state.interruptedNodeIds.length > 0) {
      throw new BridgeError(
        "collaboration_dag_recovery_required",
        `DAG run '${runId}' still contains unreconciled running nodes`,
        false,
      );
    }

    const replayNodes = snapshot.nodes.filter(
      node => node.status === "ready" && node.error?.code === "daemon_restarted",
    );
    if (replayNodes.length > 0 && options?.allowReplayInterruptedNodes !== true) {
      throw new BridgeError(
        "resume_replay_confirmation_required",
        `DAG run '${runId}' has ${replayNodes.length} interrupted node attempt(s); explicit replay acknowledgement is required`,
        false,
      );
    }

    const now = options?.now ?? (() => Date.now());
    const clock = options?.clock ?? (() => new Date().toISOString());
    const nowMs = now();
    const originMs = requireValidStartedAt(snapshot.run, nowMs);
    if (nowMs - originMs >= snapshot.run.budget.maxWallClockMs) {
      const completedAt = clock();
      this.cancelUnfinishedNodes(runId, snapshot.nodes, completedAt);
      this.persistence.finalizeRun(runId, {
        status: "timed_out",
        activeParticipantId: null,
        completedAt,
        finalSummary: `Exceeded maximum wall-clock deadline (${snapshot.run.budget.maxWallClockMs} ms)`,
      });
      throw new BridgeError("timed_out", `DAG run '${runId}' wall-clock budget is exhausted`, false);
    }
    if (snapshot.state.totalAttemptsStarted >= snapshot.run.budget.maxTurns) {
      const completedAt = clock();
      this.cancelUnfinishedNodes(runId, snapshot.nodes, completedAt);
      this.persistence.finalizeRun(runId, {
        status: "budget_exhausted",
        activeParticipantId: null,
        completedAt,
        finalSummary: `Exceeded maximum allowed turns (${snapshot.run.budget.maxTurns})`,
      });
      throw new BridgeError("budget_exhausted", `DAG run '${runId}' turn budget is exhausted`, false);
    }

    return this.persistence.getParticipants(runId);
  }

  async resume(
    runId: string,
    prepared: PreparedRoleParticipants,
    options?: CollaborationDagResumeOptions,
  ): Promise<RoleBasedCollaborationRun> {
    this.prepareResume(runId, options);
    if (this.resumingRuns.has(runId)) {
      throw new BridgeError("resume_in_progress", `DAG run '${runId}' is already being resumed`, false);
    }
    this.resumingRuns.add(runId);

    try {
      const snapshot = this.loadValidatedState(runId);
      const persistedParticipants = this.persistence.getParticipants(runId);
      if (
        prepared.plans.length !== persistedParticipants.length ||
        prepared.runtimes.length !== persistedParticipants.length
      ) {
        throw new BridgeError(
          "persistence_corruption",
          `Restored participant count mismatch for DAG run '${runId}'`,
          false,
        );
      }
      for (const persisted of persistedParticipants) {
        const plan = prepared.plans.find(item => item.participantId === persisted.id);
        const runtime = prepared.runtimes.find(item => item.participantId === persisted.id);
        if (
          !plan ||
          !runtime ||
          plan.roleId !== persisted.roleId ||
          plan.adapterId !== persisted.adapterId ||
          runtime.roleId !== persisted.roleId
        ) {
          throw new BridgeError(
            "persistence_corruption",
            `Restored participant '${persisted.id}' does not match persisted provenance`,
            false,
          );
        }
      }

      this.persistence.finalizeRun(runId, {
        status: "running",
        activeParticipantId: null,
        completedAt: null,
        finalSummary: null,
      });
      const runningRun = this.persistence.getRun(runId);
      if (!runningRun) {
        throw new BridgeError("persistence_corruption", `DAG run '${runId}' disappeared during resume`, false);
      }

      const rootAbortController = new AbortController();
      const onSignalAbort = () => rootAbortController.abort(options?.signal?.reason);
      if (options?.signal?.aborted) {
        rootAbortController.abort(options.signal.reason);
      } else {
        options?.signal?.addEventListener("abort", onSignalAbort, { once: true });
      }

      const control: ActiveCollaborationDagRunControl = {
        runId,
        rootAbortController,
        persistence: this.persistence,
        attemptsStarted: snapshot.state.totalAttemptsStarted,
      };
      this.activeRuns.set(runId, control);

      const interruptedReplayCount = snapshot.nodes.filter(
        node => node.status === "ready" && node.error?.code === "daemon_restarted",
      ).length;
      this.emit({
        eventType: "collaboration.dag.resumed",
        runId,
        sessionId: runningRun.sessionId,
        payload: {
          schemaVersion: 1,
          interruptedReplayCount,
          completedNodeCount: snapshot.nodes.filter(node => node.status === "completed").length,
          pendingNodeCount: snapshot.nodes.filter(node =>
            node.status === "pending" || node.status === "ready"
          ).length,
        },
      });

      const executionOptions: CollaborationDagExecutionOptions = {
        signal: options?.signal,
        clock: options?.clock,
        now: options?.now,
        failurePolicy: snapshot.metadata.failurePolicy,
      };
      const settlement = this.executeLoop(
        runningRun,
        prepared,
        snapshot.state.plan,
        control,
        executionOptions,
        snapshot.state.statusesByNode,
      )
        .catch(error => {
          if (error instanceof BridgeError && error.code === "collaboration_persistence_failed") {
            throw error;
          }
          return this.settleFailure(
            runningRun,
            snapshot.state.plan,
            control,
            error,
            options?.clock ?? (() => new Date().toISOString()),
          );
        })
        .finally(() => {
          options?.signal?.removeEventListener("abort", onSignalAbort);
          this.activeRuns.delete(runId);
          this.settlements.delete(runId);
        });

      this.settlements.set(runId, settlement);
      return runningRun;
    } finally {
      this.resumingRuns.delete(runId);
    }
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

  isDagRun(runId: string): boolean {
    return this.persistence.getMetadata(runId) !== null;
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
              instruction: node.instruction,
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
