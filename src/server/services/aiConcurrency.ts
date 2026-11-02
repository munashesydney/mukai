import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import type { AIActivity, AIWork, AIWorkContext } from '../../shared/aiActivity';
import { DEFAULT_AI_CONCURRENCY } from '../../shared/limits';

interface Lease {
  work: AIWork;
  release(): void;
}
interface Waiting {
  work: AIWork;
  start(): void;
  cancel(error: unknown): void;
}

/** One pool per backend, shared by every workspace and every kind of model generation. */
export class AIConcurrency {
  private closed = false;
  private active = new Map<string, Lease>();
  private queue: Waiting[] = [];
  private context = new AsyncLocalStorage<{
    meta: AIWorkContext;
    lease?: Lease;
    signal?: AbortSignal;
  }>();
  constructor(
    private capacity: () => number = () => DEFAULT_AI_CONCURRENCY,
    private workspaceName: (id: string) => string = (id) => id,
  ) {}
  snapshot(): AIActivity {
    return {
      limit: this.capacity(),
      running: [...this.active.values()].map((entry) => entry.work),
      queued: this.queue.map((entry) => entry.work),
    };
  }
  waiting(messageId: string) {
    return this.queue.some((entry) => entry.work.messageId === messageId);
  }
  withContext<T>(meta: AIWorkContext, operation: () => T, signal?: AbortSignal): T {
    const current = this.context.getStore();
    return this.context.run(
      { ...current, meta: { ...current?.meta, ...meta }, signal: signal ?? current?.signal },
      operation,
    );
  }
  async run<T>(
    meta: AIWorkContext,
    signal: AbortSignal,
    operation: () => PromiseLike<T>,
  ): Promise<T> {
    const current = this.context.getStore();
    signal = current?.signal ? AbortSignal.any([signal, current.signal]) : signal;
    signal.throwIfAborted();
    if (current?.lease && this.active.has(current.lease.work.id)) return operation();
    const lease = await this.acquire({ ...current?.meta, ...meta }, signal);
    try {
      signal.throwIfAborted();
      return await this.context.run({ meta: lease.work, lease, signal }, operation);
    } finally {
      lease.release();
    }
  }
  private acquire(meta: AIWorkContext, signal?: AbortSignal): Promise<Lease> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('AI scheduler is shutting down.');
    const work: AIWork = {
      kind: meta.kind,
      workspaceId: meta.workspaceId,
      botId: meta.botId,
      conversationId: meta.conversationId,
      messageId: meta.messageId,
      id: randomUUID(),
      queuedAt: new Date().toISOString(),
      workspaceName: meta.workspaceId
        ? this.workspaceName(meta.workspaceId)
        : meta.kind === 'memory'
          ? 'Shared memory'
          : 'Provider settings',
    };
    return new Promise((resolve, reject) => {
      const abort = () => waiting.cancel(signal?.reason);
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const waiting: Waiting = {
        work,
        cancel: (error) => {
          const index = this.queue.indexOf(waiting);
          if (index < 0) return;
          this.queue.splice(index, 1);
          cleanup();
          reject(error);
          this.drain();
        },
        start: () => {
          cleanup();
          work.startedAt = new Date().toISOString();
          const release = () => {
            signal?.removeEventListener('abort', release);
            if (this.active.delete(work.id)) this.drain();
          };
          const lease = { work, release };
          this.active.set(work.id, lease);
          signal?.addEventListener('abort', release, { once: true });
          resolve(lease);
        },
      };
      this.queue.push(waiting);
      signal?.addEventListener('abort', abort, { once: true });
      this.drain();
    });
  }
  close() {
    this.closed = true;
    for (const entry of [...this.queue]) entry.cancel(new Error('AI scheduler is shutting down.'));
  }
  drain() {
    if (this.closed) return;
    while (this.active.size < this.capacity() && this.queue.length) this.queue.shift()!.start();
  }
  middleware(owner: Omit<AIWorkContext, 'kind'> = {}): LanguageModelMiddleware {
    return {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate, params }) => {
        const current = this.context.getStore();
        if (current?.lease && this.active.has(current.lease.work.id)) return doGenerate();
        return this.run(
          { kind: 'chat', ...owner, ...current?.meta },
          params.abortSignal ?? new AbortController().signal,
          doGenerate,
        );
      },
      wrapStream: async ({ doStream, params }) => {
        const current = this.context.getStore();
        if (current?.lease && this.active.has(current.lease.work.id)) return doStream();
        const lease = await this.acquire(
          { kind: 'chat', ...owner, ...current?.meta },
          params.abortSignal,
        );
        try {
          params.abortSignal?.throwIfAborted();
          const result = await doStream();
          const reader = result.stream.getReader();
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const part = await reader.read();
                if (part.done) {
                  lease.release();
                  controller.close();
                } else controller.enqueue(part.value);
              } catch (error) {
                lease.release();
                controller.error(error);
              }
            },
            cancel(reason) {
              lease.release();
              return reader.cancel(reason);
            },
          });
          return { ...result, stream };
        } catch (error) {
          lease.release();
          throw error;
        }
      },
    };
  }
}
