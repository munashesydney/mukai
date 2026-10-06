import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationTimeout } from './generationTimeout';

afterEach(() => vi.useRealTimers());
describe('Generation timeout', () => {
  it('excludes parallel tool execution and gives the resumed provider a fresh idle window', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let pendingTools = 0;
    const timeout = new GenerationTimeout(() => pendingTools > 0, controller, 180000, 45000);
    vi.advanceTimersByTime(44000);
    pendingTools = 2;
    vi.advanceTimersByTime(240000);
    pendingTools = 1;
    vi.advanceTimersByTime(240000);
    expect(controller.signal.aborted).toBe(false);
    pendingTools = 0;
    vi.advanceTimersByTime(44750);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(250);
    expect(controller.signal.reason.name).toBe('TimeoutError');
    timeout.dispose();
  });

  it('does not interfere with explicit cancellation while a tool is running', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = new GenerationTimeout(() => true, controller, 180000, 45000);
    controller.abort(new Error('User stopped the response.'));
    vi.advanceTimersByTime(240000);
    expect(controller.signal.reason.message).toBe('User stopped the response.');
    timeout.dispose();
  });
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
