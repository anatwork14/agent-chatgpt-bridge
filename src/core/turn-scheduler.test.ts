import { expect, test } from "bun:test";
import { TurnScheduler } from "./turn-scheduler";
import { BridgeError } from "./errors";

test("TurnScheduler caps active work and rejects queue overflow", async () => {
  const scheduler = new TurnScheduler(1, 1);
  const releaseFirst = await scheduler.acquire("normal");
  const queued = scheduler.acquire("normal");

  let overflow: unknown;
  try {
    await scheduler.acquire("interactive");
  } catch (error) {
    overflow = error;
  }
  expect(overflow).toBeInstanceOf(BridgeError);
  expect((overflow as BridgeError).code).toBe("local_queue_full");

  releaseFirst();
  const releaseSecond = await queued;
  expect(scheduler.snapshot().active).toBe(1);
  releaseSecond();
  expect(scheduler.snapshot().active).toBe(0);
});

test("TurnScheduler prioritizes interactive work without reordering peers", async () => {
  const scheduler = new TurnScheduler(1, 4);
  const releaseFirst = await scheduler.acquire("normal");
  const order: string[] = [];

  const normal = scheduler.acquire("normal").then(release => {
    order.push("normal");
    release();
  });
  const interactiveA = scheduler.acquire("interactive").then(release => {
    order.push("interactive-a");
    release();
  });
  const interactiveB = scheduler.acquire("interactive").then(release => {
    order.push("interactive-b");
    release();
  });

  releaseFirst();
  await Promise.all([normal, interactiveA, interactiveB]);
  expect(order).toEqual(["interactive-a", "interactive-b", "normal"]);
});

test("TurnScheduler removes an aborted queued waiter", async () => {
  const scheduler = new TurnScheduler(1, 2);
  const releaseFirst = await scheduler.acquire();
  const controller = new AbortController();
  const waiting = scheduler.acquire("normal", controller.signal);
  controller.abort();

  let error: unknown;
  try {
    await waiting;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("client_cancelled");
  expect(scheduler.snapshot().queued).toBe(0);
  releaseFirst();
});
