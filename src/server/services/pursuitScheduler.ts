import { AsyncLocalStorage } from 'node:async_hooks';

/** A single FIFO pool shared by every pursuit, including runs restored at startup. */
export class PursuitScheduler {
  private owners = new Set<PursuitExecution>();
  private queue = new Map<PursuitExecution, { promise: Promise<void>; resolve: () => void }>();
  constructor(private limit: () => number) {}
  get used() {
    return this.owners.size;
  }
  owns(owner: PursuitExecution) {
    return this.owners.has(owner);
  }
  acquire(owner: PursuitExecution): Promise<void> {
    if (this.owners.has(owner)) return Promise.resolve();
    const existing = this.queue.get(owner);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.queue.set(owner, { promise, resolve });
    this.drain();
    return promise;
  }
  release(owner: PursuitExecution) {
    this.owners.delete(owner);
    const queued = this.queue.get(owner);
    this.queue.delete(owner);
    queued?.resolve();
    this.drain();
  }
  drain() {
    for (const [owner, item] of this.queue) {
      if (this.used >= this.limit()) break;
      this.queue.delete(owner);
      this.owners.add(owner);
      item.resolve();
    }
  }
}

const context = new AsyncLocalStorage<{
  execution: PursuitExecution;
  pause?: <T>(operation: () => Promise<T>) => Promise<T>;
}>();

/** Also used around delegation: child work shares its parent's pursuit slot. */
export function pausePursuitTask<T>(operation: () => Promise<T>): Promise<T> {
  return context.getStore()?.pause?.(operation) ?? operation();
}
export function pursuitSession() {
  return context.getStore()?.execution.session();
}
export function inPursuitExecution() {
  return Boolean(context.getStore());
}

export class PursuitExecution {
  private active = 0;
  private controller = new AbortController();
  constructor(private pool: PursuitScheduler) {}
  async run<T>(operation: () => Promise<T>) {
    // Reserve immediately, but let restored chats attach their pending cards and
    // cancellation handlers before waiting for capacity at an execution boundary.
    void this.pool.acquire(this);
    try {
      return await context.run({ execution: this }, operation);
    } finally {
      this.close();
    }
  }
  close() {
    this.controller.abort();
    this.pool.release(this);
  }
  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    const combined = AbortSignal.any([signal, this.controller.signal]);
    combined.throwIfAborted();
    let abort!: () => void;
    try {
      await Promise.race([
        this.pool.acquire(this),
        new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener('abort', abort, { once: true });
        }),
      ]);
      combined.throwIfAborted();
    } finally {
      combined.removeEventListener('abort', abort);
    }
  }
  private async activate(signal: AbortSignal) {
    this.active++;
    try {
      await this.acquire(signal);
    } catch (error) {
      this.idle();
      throw error;
    }
  }
  private idle() {
    this.active--;
    if (!this.active) this.pool.release(this);
  }
  session() {
    let providerActive = false;
    const endProvider = () => {
      if (providerActive) {
        providerActive = false;
        this.idle();
      }
    };
    return {
      waiting: () => this.active > 0 && !this.pool.owns(this),
      provider: async (signal: AbortSignal) => {
        await this.activate(signal);
        providerActive = true;
      },
      endProvider,
      tool: async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
        // Transfer the provider's slot to its tools without a gap between them.
        const activation = this.activate(signal);
        endProvider();
        await activation;
        let active = true;
        try {
          return await context.run(
            {
              execution: this,
              pause: async <R>(waiting: () => Promise<R>) => {
                active = false;
                this.idle();
                try {
                  return await waiting();
                } finally {
                  await this.activate(signal);
                  active = true;
                }
              },
            },
            operation,
          );
        } finally {
          if (active) this.idle();
        }
      },
    };
  }
}
