import type { CollaborationRun, ExternalAgentAdapter, AgentDecision, AgentTurnInput } from "./domain";
import { generateRunId } from "./ids";
import type { RunStore } from "../persistence/run-store";
import type { SessionManager } from "./session-manager";
import { BridgeError } from "./errors";

export class RunController {
  private activeRuns = new Map<string, AbortController>();

  constructor(
    private runStore: RunStore,
    private sessionManager: SessionManager,
    private getAgentAdapter: (id: string, command?: string[]) => ExternalAgentAdapter
  ) {}

  async startRun(
    sessionId: string,
    objective: string,
    agentAdapterId: string,
    command?: string[],
    budgetOverrides?: Partial<CollaborationRun["budget"]>
  ): Promise<CollaborationRun> {
    const run: CollaborationRun = {
      id: generateRunId(),
      sessionId,
      agentAdapterId,
      objective,
      status: "running",
      round: 0,
      budget: {
        maxRounds: budgetOverrides?.maxRounds || 20,
        maxWallClockMs: budgetOverrides?.maxWallClockMs || 3600000,
        maxConsecutiveFailures: budgetOverrides?.maxConsecutiveFailures || 3,
      },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    
    // Safety
    if (run.budget.maxRounds > 100) run.budget.maxRounds = 100;

    this.runStore.create(run);

    const abortController = new AbortController();
    this.activeRuns.set(run.id, abortController);

    // Start background loop
    this.runLoop(run, command, abortController.signal).catch(console.error);

    return run;
  }

  async cancelRun(runId: string) {
    const abort = this.activeRuns.get(runId);
    if (abort) {
      abort.abort();
      this.activeRuns.delete(runId);
    }
    const run = this.runStore.get(runId);
    if (run && run.status === "running") {
      this.runStore.update(runId, { status: "cancelled", completedAt: new Date().toISOString() });
    }
  }

  private async runLoop(run: CollaborationRun, command: string[] | undefined, signal: AbortSignal) {
    let consecutiveFailures = 0;
    const adapter = this.getAgentAdapter(run.agentAdapterId, command);
    const startTime = Date.now();

    let lastChatGptResponse: { text: string } | undefined;

    try {
      while (true) {
        if (signal.aborted) {
          this.runStore.update(run.id, { status: "cancelled", completedAt: new Date().toISOString() });
          break;
        }

        if (run.round >= run.budget.maxRounds) {
          this.runStore.update(run.id, { status: "budget_exhausted", completedAt: new Date().toISOString() });
          break;
        }

        if (Date.now() - startTime > run.budget.maxWallClockMs) {
          this.runStore.update(run.id, { status: "budget_exhausted", completedAt: new Date().toISOString() });
          break;
        }

        const input: AgentTurnInput = {
          runId: run.id,
          objective: run.objective,
          round: run.round,
          lastChatGptResponse,
        };

        let decision: AgentDecision;
        try {
          decision = await adapter.next(input, { signal });
        } catch (e: any) {
          decision = { type: "error", message: e.message, retryable: false };
        }

        if (decision.type === "error") {
          consecutiveFailures++;
          if (!decision.retryable || consecutiveFailures > run.budget.maxConsecutiveFailures) {
            this.runStore.update(run.id, { status: "failed", completedAt: new Date().toISOString(), finalSummary: decision.message });
            break;
          }
          // Retry logic could delay here
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        consecutiveFailures = 0; // reset

        if (decision.type === "done") {
          this.runStore.update(run.id, { status: "completed", completedAt: new Date().toISOString(), finalSummary: decision.summary });
          break;
        }

        if (decision.type === "pause") {
          this.runStore.update(run.id, { status: "created" }); // Or paused
          break;
        }

        if (decision.type === "message") {
          // Send to ChatGPT
          const chatgptRes = await this.sessionManager.send(run.sessionId, {
            source: "agent",
            model: { provider: "chatgpt-web", model: "auto" },
            messages: [{
              id: "msg_" + Date.now() + Math.random(),
              role: "user",
              content: [{ type: "text", text: decision.content }],
              createdAt: new Date().toISOString(),
            }],
            stream: false,
          }, { emit: () => {} });
          
          lastChatGptResponse = { text: chatgptRes.text };
          
          run.round++;
          this.runStore.update(run.id, { round: run.round });
        }
      }
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  getRun(runId: string): CollaborationRun | null {
    return this.runStore.get(runId);
  }
}
