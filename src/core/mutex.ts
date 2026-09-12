import { BridgeError } from "./errors";

interface Waiter {
  grant: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Mutex {
  private readonly queue: Waiter[] = [];
  private locked = false;

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new BridgeError("client_cancelled", "Request was cancelled while waiting for the session", false);
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        reject,
        signal,
        grant: () => {
          if (signal && waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
          this.locked = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.release();
          });
        },
      };

      if (!this.locked) {
        waiter.grant();
        return;
      }

      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new BridgeError("client_cancelled", "Request was cancelled while waiting for the session", false));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        next.reject(new BridgeError("client_cancelled", "Request was cancelled while waiting for the session", false));
        continue;
      }
      next.grant();
      return;
    }
    this.locked = false;
  }
}
