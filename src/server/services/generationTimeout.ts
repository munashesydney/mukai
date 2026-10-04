/** Provider time limits exclude time spent waiting for a human tool decision. */
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
    if (this.waiting()) return;
    this.total += elapsed;
    this.idle += elapsed;
    if (this.total >= this.totalMs || this.idle >= this.idleMs)
      this.controller.abort(new DOMException('The provider response timed out.', 'TimeoutError'));
  }
  chunk() {
    this.tick();
    this.idle = 0;
  }
  dispose() {
    clearInterval(this.timer);
  }
}
