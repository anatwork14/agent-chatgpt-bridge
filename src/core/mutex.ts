export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const lock = () => {
        this.locked = true;
        resolve(() => this.release());
      };
      if (this.locked) {
        this.queue.push(lock);
      } else {
        lock();
      }
    });
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}
