type Priority = 'foreground' | 'background';
type Waiting = {
  priority: Priority;
  start(): void;
  reject(error: unknown): void;
  cleanup(): void;
};

/** Keep background reads below the guest's limit and leave room for interactive work. */
export class RequestScheduler {
  private active = 0;
  private background = 0;
  private waiting: Waiting[] = [];
  constructor(
    private limit = 24,
    private backgroundLimit = 4,
    private queueLimit = 256,
    private waitMs = 15000,
  ) {}
  run<T>(task: () => Promise<T>, signal: AbortSignal, priority: Priority = 'foreground') {
    signal.throwIfAborted();
    if (this.waiting.length >= this.queueLimit)
      return Promise.reject(
        new Error('The workspace VM request queue is full. Try again shortly.'),
      );
    return new Promise<T>((resolve, reject) => {
      const remove = (error: unknown) => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup();
        reject(error);
        this.drain();
      };
      const abort = () => remove(signal.reason);
      const timer = setTimeout(
        () => remove(new Error('The workspace VM is busy. Try again shortly.')),
        this.waitMs,
      );
      const entry: Waiting = {
        priority,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        },
        reject,
        start: () => {
          entry.cleanup();
          this.active++;
          if (priority === 'background') this.background++;
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return task();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              if (priority === 'background') this.background--;
              this.drain();
            });
        },
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', abort, { once: true });
      this.drain();
    });
  }
  clear(error: Error) {
    for (const entry of this.waiting.splice(0)) {
      entry.cleanup();
      entry.reject(error);
    }
  }
  private drain() {
    while (this.active < this.limit) {
      let index = this.waiting.findIndex((entry) => entry.priority === 'foreground');
      if (index < 0 && this.background < this.backgroundLimit) index = 0;
      if (index < 0 || !this.waiting.length) return;
      this.waiting.splice(index, 1)[0].start();
    }
  }
}
