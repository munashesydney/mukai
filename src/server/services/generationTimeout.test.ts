import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationTimeout } from './generationTimeout';

afterEach(() => vi.useRealTimers());
describe('Generation timeout', () => {
  it('allows long human approval waits and restores the remaining idle budget afterward', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let waiting = false;
    const timeout = new GenerationTimeout(() => waiting, controller, 180000, 45000);
    vi.advanceTimersByTime(10000);
    waiting = true;
    vi.advanceTimersByTime(600000);
    expect(controller.signal.aborted).toBe(false);
    waiting = false;
    timeout.chunk();
    vi.advanceTimersByTime(44750);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(250);
    expect(controller.signal.reason.name).toBe('TimeoutError');
    timeout.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the total budget despite continuous provider output', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = new GenerationTimeout(() => false, controller, 1000, 500);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(250);
      timeout.chunk();
    }
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(250);
    expect(controller.signal.aborted).toBe(true);
    timeout.dispose();
  });
});
