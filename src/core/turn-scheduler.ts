import { BridgeError } from "./errors";

export type TurnPriority = "interactive" | "normal";

interface Waiter {
  priority: TurnPriority;
  sequence: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface TurnSchedulerSnapshot {
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
}

export class TurnScheduler {
  private active = 0;
  private sequence = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxActive = 5,
    private readonly maxQueued = 100,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("maxActive must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  snapshot(): TurnSchedulerSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    };
  }

  async acquire(
    priority: TurnPriority = "normal",
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) {
      throw new BridgeError("client_cancelled", "Turn was cancelled while waiting for capacity", false);
    }

    if (this.active < this.maxActive) {
      this.active += 1;
      return this.releaseHandle();
    }

    if (this.queue.length >= this.maxQueued) {
      throw new BridgeError(
        "local_queue_full",
        `Bridge turn queue is full (${this.maxQueued} waiting)`,
        true,
      );
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new BridgeError("client_cancelled", "Turn was cancelled while queued", false));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.sortQueue();
    });
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const priorityDelta = (a.priority === "interactive" ? 0 : 1)
        - (b.priority === "interactive" ? 0 : 1);
      return priorityDelta || a.sequence - b.sequence;
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(new BridgeError("client_cancelled", "Turn was cancelled while queued", false));
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}
