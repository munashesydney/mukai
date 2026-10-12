import { Worker } from 'node:worker_threads';
import { ApiError } from '../config';
import { workerSource } from './worker';

/** Shared bounded worker runner; instantiated separately on host and guest. */
export class CapabilityWorkers {
  private closing = false;
  private workers = new Set<Worker>();
  private pending = new Set<Promise<unknown>>();
  constructor(
    private error: (error: unknown) => string = (error) =>
      String(error instanceof Error ? error.message : error).slice(0, 2000),
  ) {}
  async shutdown() {
    this.closing = true;
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
    await Promise.allSettled([...this.pending]);
  }
  run(
    data: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    rpc?: (action: string, args: unknown[]) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.closing) return Promise.reject(new ApiError(503, 'Capability runtime is stopping.'));
    if (this.workers.size >= 8)
      return Promise.reject(new ApiError(429, 'Custom capability concurrency limit reached.'));
    const operation = new Promise<unknown>((resolve, reject) => {
      signal?.throwIfAborted();
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: data,
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      this.workers.add(worker);
      // Drain and discard stdout/stderr: arbitrary module logs may contain secrets.
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate().finally(() => {
          this.workers.delete(worker);
          if (error) reject(error);
          else resolve(value);
        });
      };
      const abort = () => {
        worker.postMessage({ type: 'abort' });
        finish(new ApiError(499, 'Capability execution cancelled.'));
      };
      const timer = setTimeout(
        () =>
          finish(new ApiError(504, 'Capability execution timed out; its worker was terminated.')),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('error', (error) => finish(new ApiError(500, this.error(error))));
      worker.on('exit', () =>
        finish(new ApiError(500, 'Capability worker exited before completing.')),
      );
      worker.on(
        'message',
        (message: {
          type: string;
          value?: unknown;
          error?: string;
          id: number;
          action: string;
          args: unknown[];
        }) => {
          if (message.type === 'result') finish(undefined, message.value);
          else if (message.type === 'error')
            finish(new ApiError(400, this.error(message.error || 'Capability failed.')));
          else if (message.type === 'rpc' && !settled) {
            Promise.resolve()
              .then(() =>
                rpc
                  ? rpc(message.action, message.args)
                  : Promise.reject(new Error('Helpers are unavailable during validation.')),
              )
              .then(
                (value) => {
                  if (!settled) worker.postMessage({ type: 'reply', id: message.id, value });
                },
                (error) => {
                  if (!settled)
                    worker.postMessage({ type: 'reply', id: message.id, error: this.error(error) });
                },
              );
          }
        },
      );
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
}
