/**
 * Cadence for background reads.
 *
 * Fixed intervals are the wrong shape for polling: the interesting state
 * changes in bursts and then sits still for minutes, and a `setInterval` keeps
 * firing while the tab is hidden, while its own requests are still in flight,
 * and while nothing has moved. This schedules the next tick only after the last
 * one settled, backs off while results stop changing, and pauses when the tab
 * is out of sight.
 */

/** Returning `false` means "the poll ran and nothing changed". */
export type PollOutcome = boolean | void;

export interface PollOptions {
  /** Cadence while the polled data keeps changing. */
  interval: number;
  /** Ceiling for the idle backoff. Defaults to `interval`, which means no backoff. */
  maxInterval?: number;
  /** Cadence while the tab is hidden. Defaults to pausing until it is visible again. */
  hiddenInterval?: number;
  /** Keep polling while hidden, for state the user cannot act on from this tab anyway. */
  runWhenHidden?: boolean;
  /** Fraction of the delay used as random spread, so many pollers do not peak together. */
  jitter?: number;
  /** Run the first tick straight away. Defaults to true. */
  immediate?: boolean;
}

export interface PollHandle {
  stop(): void;
  /** Nominal delay until the next tick; lets a caller check its own state to adapt. */
  frequency(): number;
  /** Poll now and resume the base cadence, as after a local mutation. */
  refresh(): void;
}

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function startPoll(
  task: () => PollOutcome | Promise<PollOutcome>,
  options: PollOptions,
): PollHandle {
  const interval = Math.max(1, options.interval);
  const maxInterval = Math.max(interval, options.maxInterval ?? interval);
  const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.15));
  const watchVisibility = typeof document !== 'undefined' && !!document.addEventListener;

  let stopped = false;
  let running = false;
  let idleTicks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** null means "do not schedule anything; wait to become visible again". */
  function nominalDelay(): number | null {
    if (isHidden() && !options.runWhenHidden) {
      return options.hiddenInterval === undefined ? null : options.hiddenInterval;
    }
    return Math.min(maxInterval, interval * 2 ** idleTicks);
  }

  function schedule() {
    if (stopped) return;
    const base = nominalDelay();
    if (base === null) return;
    timer = setTimeout(tick, base * (1 + jitter * Math.random()));
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    let unchanged = false;
    try {
      unchanged = (await task()) === false;
    } catch (error) {
      // A read that failed is a read that changed nothing visible: back off, retry.
      unchanged = true;
      console.error('Poll failed:', error);
    } finally {
      running = false;
    }
    idleTicks = unchanged ? idleTicks + 1 : 0;
    schedule();
  }

  function onVisibility() {
    if (isHidden()) return;
    idleTicks = 0;
    if (running) return; // the tick already in flight will schedule the next one
    if (timer) clearTimeout(timer);
    timer = undefined;
    void tick();
  }

  if (watchVisibility) document.addEventListener('visibilitychange', onVisibility);

  if (options.immediate === false) schedule();
  else void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (watchVisibility) document.removeEventListener('visibilitychange', onVisibility);
    },
    frequency() {
      return nominalDelay() ?? interval;
    },
    refresh() {
      if (stopped) return;
      idleTicks = 0;
      if (running) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void tick();
    },
  };
}
