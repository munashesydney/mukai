import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import type { AIActivity, AIWork, AIWorkContext, AIMemoryPressure } from '../../shared/aiActivity';
import { DEFAULT_AI_CONCURRENCY } from '../../shared/limits';
import {
  isProviderMemoryError,
  MEMORY_RETRY_DELAYS,
  MEMORY_RETRY_LIMIT,
  MEMORY_RECOVERY_QUIET_MS,
  MEMORY_RECOVERY_SUCCESSES,
  MemoryRecoveryExhaustedError,
  ProviderMemoryError,
} from './memoryRecovery';

interface Lease {
  work: AIWork;
  release(error?: unknown, successful?: boolean): void;
}
interface Waiting {
  work: AIWork;
  start(): void;
  cancel(error: unknown): void;
}

/** One pool per backend, shared by every workspace and every kind of model generation. */
export class AIConcurrency {
  private closed = false;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private providers = new Map<string, { key: string; name: string }>();
  private pressure = new Map<
    string,
    {
      providerId: string;
      name: string;
      limit: number;
      until: number;
      failures: number;
      lastFailure: number;
      successes: number;
    }
  >();
  provider(source: { id: string; name: string; kind?: string; baseUrl?: string }) {
    let key = source.id;
    if (source.kind === 'compatible' && source.baseUrl) {
      try {
        const url = new URL(source.baseUrl);
        if (url.hostname === 'localhost' || url.hostname === '[::1]') url.hostname = '127.0.0.1';
        key = url.origin + url.pathname.replace(/\/+$/, '');
      } catch {
        /* Invalid endpoints are rejected by the provider itself. */
      }
    }
    const previous = this.providers.get(source.id);
    if (previous && previous.key !== key) this.pressure.delete(previous.key);
    this.providers.set(source.id, { key, name: source.name });
    return { providerId: source.id, providerName: source.name };
  }
  private providerKey(work: AIWorkContext) {
    return this.providers.get(work.providerId || '')?.key || work.providerId || 'local-memory';
  }
  private pressureInfo(work: AIWorkContext): AIMemoryPressure | undefined {
    const state = this.pressure.get(this.providerKey(work));
    if (!state) return;
    return {
      providerId: work.providerId || state.providerId,
      providerName: work.providerName || state.name,
      configuredLimit: this.capacity(),
      effectiveLimit: Math.min(this.capacity(), state.limit),
      ...(state.until > Date.now() ? { cooldownUntil: new Date(state.until).toISOString() } : {}),
    };
  }
  private failed(work: AIWorkContext) {
    const key = this.providerKey(work);
    const old = this.pressure.get(key);
    const failures = (old?.failures || 0) + 1;
    this.pressure.set(key, {
      providerId: work.providerId || 'local-memory',
      name: work.providerName || 'AI provider',
      limit: Math.max(1, Math.floor(Math.min(old?.limit ?? this.capacity(), this.capacity()) / 2)),
      until:
        Date.now() + MEMORY_RETRY_DELAYS[Math.min(failures - 1, MEMORY_RETRY_DELAYS.length - 1)],
      lastFailure: Date.now(),
      failures,
      successes: 0,
    });
  }
  private healthy(work: AIWorkContext) {
    const key = this.providerKey(work),
      state = this.pressure.get(key);
    if (!state) return;
    state.successes++;
    if (
      Date.now() - state.lastFailure < MEMORY_RECOVERY_QUIET_MS ||
      state.successes < MEMORY_RECOVERY_SUCCESSES
    )
      return;
    state.limit++;
    state.successes = 0;
    if (state.limit >= this.capacity()) this.pressure.delete(key);
  }
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
      running: [...this.active.values()].map((entry) => ({
        ...entry.work,
        ...(this.pressureInfo(entry.work) ? { memoryPressure: this.pressureInfo(entry.work) } : {}),
      })),
      queued: this.queue.map((entry) => ({
        ...entry.work,
        ...(this.pressureInfo(entry.work) ? { memoryPressure: this.pressureInfo(entry.work) } : {}),
      })),
      ...(this.pressure.size
        ? {
            memoryPressure: [...this.pressure.values()].map((state) =>
              this.pressureInfo({ kind: 'chat', providerId: state.providerId })!,
            ),
          }
        : {}),
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
    for (let attempt = 0; ; attempt++) {
      const work = {
        ...current?.meta,
        ...meta,
        ...(attempt
          ? { memoryRetry: { attempt, maxAttempts: MEMORY_RETRY_LIMIT, phase: 'retry' as const } }
          : {}),
      };
      const lease = await this.acquire(work, signal);
      try {
        signal.throwIfAborted();
        const value = await this.context.run({ meta: lease.work, lease, signal }, operation);
        lease.release(undefined, true);
        return value;
      } catch (error) {
        lease.release(error);
        signal.throwIfAborted();
        if (!isProviderMemoryError(error) || error instanceof MemoryRecoveryExhaustedError)
          throw error;
        if (attempt >= MEMORY_RETRY_LIMIT) throw new MemoryRecoveryExhaustedError(error);
      } finally {
        lease.release();
      }
    }
  }
  private acquire(meta: AIWorkContext, signal?: AbortSignal): Promise<Lease> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('AI scheduler is shutting down.');
    const work: AIWork = {
      kind: meta.kind,
      providerId: meta.providerId,
      providerName: meta.providerName,
      memoryRetry: meta.memoryRetry,
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
          const abortActive = () => release();
          const release = (error?: unknown, successful = false) => {
            signal?.removeEventListener('abort', abortActive);
            if (!this.active.has(work.id)) return;
            if (isProviderMemoryError(error)) this.failed(work);
            else if (successful && !signal?.aborted) this.healthy(work);
            this.active.delete(work.id);
            this.drain();
          };
          const lease = { work, release };
          this.active.set(work.id, lease);
          signal?.addEventListener('abort', abortActive, { once: true });
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
    clearTimeout(this.wakeTimer);
    for (const entry of [...this.queue]) entry.cancel(new Error('AI scheduler is shutting down.'));
  }
  drain() {
    clearTimeout(this.wakeTimer);
    if (this.closed) return;
    while (this.active.size < this.capacity()) {
      const index = this.queue.findIndex(({ work }) => {
        const key = this.providerKey(work),
          state = this.pressure.get(key);
        if (!state) return true;
        if (state.until > Date.now()) return false;
        return (
          [...this.active.values()].filter((entry) => this.providerKey(entry.work) === key).length <
          Math.min(state.limit, this.capacity())
        );
      });
      if (index < 0) break;
      this.queue.splice(index, 1)[0].start();
    }
    const deadlines = this.queue
      .map(({ work }) => this.pressure.get(this.providerKey(work))?.until || 0)
      .filter((time) => time > Date.now());
    if (deadlines.length) {
      this.wakeTimer = setTimeout(
        () => this.drain(),
        Math.max(1, Math.min(...deadlines) - Date.now()),
      );
      this.wakeTimer.unref?.();
    }
  }
  middleware(owner: Omit<AIWorkContext, 'kind'> = {}): LanguageModelMiddleware {
    return {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate, params }) => {
        const current = this.context.getStore();
        const generate = async () => {
          try {
            return await doGenerate();
          } catch (error) {
            if (isProviderMemoryError(error)) throw new ProviderMemoryError(error);
            throw error;
          }
        };
        if (current?.lease && this.active.has(current.lease.work.id)) return generate();
        return this.run(
          { kind: 'chat', ...current?.meta, ...owner },
          params.abortSignal ?? new AbortController().signal,
          generate,
        );
      },
      wrapStream: async ({ doStream, params }) => {
        const current = this.context.getStore();
        if (current?.lease && this.active.has(current.lease.work.id)) return doStream();
        const lease = await this.acquire(
          { kind: 'chat', ...current?.meta, ...owner },
          params.abortSignal,
        );
        try {
          params.abortSignal?.throwIfAborted();
          const result = await doStream();
          const reader = result.stream.getReader();
          let failure: unknown,
            finished = false;
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const part = await reader.read();
                if (part.done) {
                  lease.release(failure, finished && !failure);
                  controller.close();
                } else {
                  if (part.value.type === 'error') {
                    failure = part.value.error;
                    if (isProviderMemoryError(failure)) lease.release(failure);
                  }
                  if (part.value.type === 'finish') finished = true;
                  controller.enqueue(part.value);
                }
              } catch (error) {
                lease.release(error);
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
          lease.release(error);
          if (isProviderMemoryError(error)) throw new ProviderMemoryError(error);
          throw error;
        }
      },
    };
  }
}
