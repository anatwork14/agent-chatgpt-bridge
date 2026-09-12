import { expect, test, afterEach } from "bun:test";
import { RunController } from "./run-controller";
import { RunStore } from "../persistence/run-store";
import { AuditStore } from "../persistence/audit-store";
import { SessionManager } from "./session-manager";
import { FakeConversationProvider } from "../providers/fake/provider";
import { initDatabase, closeDatabase } from "../persistence/database";
import { SessionStore } from "../persistence/session-store";
import { MessageStore } from "../persistence/message-store";
import { TurnStore } from "../persistence/turn-store";
import type { ExternalAgentAdapter, AgentDecision } from "./domain";

afterEach(() => {
  closeDatabase();
});

function manager(): SessionManager {
  return new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
    fake: new FakeConversationProvider(),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for run state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("Autonomous relay controller completes after a ChatGPT round", async () => {
  initDatabase(":memory:");
  const sm = manager();
  const session = await sm.create({ provider: "fake", model: "fake-model" });

  class MockAgent implements ExternalAgentAdapter {
    readonly id = "mock";
    async next(input: any): Promise<AgentDecision> {
      return input.round === 0
        ? { type: "message", content: "Round 0 message" }
        : { type: "done", summary: "Finished!" };
    }
  }

  const runStore = new RunStore();
  const controller = new RunController(runStore, sm, new AuditStore(), () => new MockAgent());
  const run = await controller.startRun(session.id, "Test run", "mock", [], { maxRounds: 5 });

  await waitUntil(() => controller.getRun(run.id)?.status !== "running");

  const completed = controller.getRun(run.id);
  expect(completed?.status).toBe("completed");
  expect(completed?.round).toBe(1);
  expect(completed?.finalSummary).toBe("Finished!");
  expect((await sm.transcript(session.id)).map(message => message.role)).toEqual(["user", "assistant"]);
});

test("Autonomous relay stops at max rounds", async () => {
  initDatabase(":memory:");
  const sm = manager();
  const session = await sm.create({ provider: "fake", model: "fake-model" });

  class InfiniteAgent implements ExternalAgentAdapter {
    readonly id = "infinite";
    async next(): Promise<AgentDecision> {
      return { type: "message", content: "Never done" };
    }
  }

  const controller = new RunController(new RunStore(), sm, new AuditStore(), () => new InfiniteAgent());
  const run = await controller.startRun(session.id, "Test limit", "infinite", [], { maxRounds: 2 });

  await waitUntil(() => controller.getRun(run.id)?.status !== "running");

  const exhausted = controller.getRun(run.id);
  expect(exhausted?.status).toBe("budget_exhausted");
  expect(exhausted?.round).toBe(2);
});

test("Autonomous relay is cancellable while external agent is running", async () => {
  initDatabase(":memory:");
  const sm = manager();
  const session = await sm.create({ provider: "fake", model: "fake-model" });

  class HangingAgent implements ExternalAgentAdapter {
    readonly id = "hanging";
    async next(_input: any, ctx: { signal?: AbortSignal }): Promise<AgentDecision> {
      await new Promise<void>((_resolve, reject) => {
        if (ctx.signal?.aborted) {
          reject(ctx.signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(ctx.signal?.reason ?? new DOMException("aborted", "AbortError"));
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return { type: "done", summary: "unreachable" };
    }
  }

  const controller = new RunController(new RunStore(), sm, new AuditStore(), () => new HangingAgent());
  const run = await controller.startRun(session.id, "Cancel me", "hanging");
  expect(await controller.cancelRun(run.id)).toBe(true);
  await waitUntil(() => controller.getRun(run.id)?.status !== "running");
  expect(controller.getRun(run.id)?.status).toBe("cancelled");
});
