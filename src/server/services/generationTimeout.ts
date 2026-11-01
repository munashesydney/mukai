export class GenerationTimeoutError extends Error {
  readonly name = 'MukaiProviderTimeoutError';
  readonly code: string;
  constructor(
    readonly kind: 'idle' | 'total',
    readonly limitMs: number,
  ) {
    super(`Mukai's provider watchdog reached its ${kind} limit of ${limitMs}ms.`);
    this.code = kind === 'idle' ? 'MUKAI_PROVIDER_IDLE_TIMEOUT' : 'MUKAI_PROVIDER_TOTAL_TIMEOUT';
  }
}

/** SDK/transport wrappers must not turn a runtime limit into a connection error. */
export function generationTimeoutError(error: unknown): GenerationTimeoutError | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    if (current instanceof GenerationTimeoutError) return current;
    seen.add(current);
    const wrapped = current as { cause?: unknown; lastError?: unknown };
    pending.push(wrapped.cause, wrapped.lastError);
  }
}

/** Provider time limits exclude tool execution and human decisions. */
export class GenerationTimeout {
  private total = 0;
  private idle = 0;
  private last = Date.now();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private waiting: () => boolean,
    private controller: AbortController,
    private totalMs: number,
    private idleMs: number,
  ) {
    this.timer = setInterval(() => this.tick(), 250);
  }
  private tick() {
    const now = Date.now();
    const elapsed = now - this.last;
    this.last = now;
    if (this.waiting()) {
      // A resumed provider request gets a full inactivity window.
      this.idle = 0;
      return;
    }
    this.total += elapsed;
    this.idle += elapsed;
    if (this.total >= this.totalMs)
      this.controller.abort(new GenerationTimeoutError('total', this.totalMs));
    else if (this.idle >= this.idleMs)
      this.controller.abort(new GenerationTimeoutError('idle', this.idleMs));
  }
  chunk() {
    this.tick();
    this.idle = 0;
  }
  dispose() {
    clearInterval(this.timer);
  }
}
