import type RFB from '@novnc/novnc';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { maintainComputerConnection } from './computerConnection';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeViewer() {
  return Object.assign(new EventTarget(), {
    disconnect: vi.fn(function (this: EventTarget) {
      this.dispatchEvent(new Event('disconnect'));
    }),
  });
}
function fixture() {
  const viewers: ReturnType<typeof fakeViewer>[] = [];
  const open = vi.fn(async (signal: AbortSignal, reconnect: boolean) => {
    signal.throwIfAborted();
    void reconnect;
    const viewer = fakeViewer();
    viewers.push(viewer);
    return viewer as unknown as RFB;
  });
  const options = { open, created: vi.fn(), release: vi.fn(), state: vi.fn() };
  const connection = maintainComputerConnection(options);
  return { ...options, connection, viewers };
}

it('obtains a fresh viewer after a drop and releases the old connection', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.viewers[0].dispatchEvent(new Event('connect'));
  f.viewers[0].dispatchEvent(new Event('disconnect'));
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.viewers[0].disconnect).toHaveBeenCalledOnce();
  expect(f.open.mock.calls[0][0].aborted).toBe(true);
  expect(f.state).toHaveBeenLastCalledWith('connecting', expect.stringContaining('Reconnecting'));
  await vi.advanceTimersByTimeAsync(999);
  expect(f.open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.open.mock.calls.map((call) => call[1])).toEqual([false, true]);
  f.viewers[1].dispatchEvent(new Event('connect'));
  expect(f.state).toHaveBeenLastCalledWith('connected', '');
  f.connection.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds retries even if every replacement briefly connects', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [1000, 2000, 4000, 8000]) {
    const viewer = f.viewers.at(-1)!;
    viewer.dispatchEvent(new Event('connect'));
    viewer.dispatchEvent(new Event('disconnect'));
    await vi.advanceTimersByTimeAsync(delay);
  }
  f.viewers.at(-1)!.dispatchEvent(new Event('disconnect'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.open).toHaveBeenCalledTimes(5);
  expect(f.state).toHaveBeenLastCalledWith('disconnected', expect.any(String));
  expect(vi.getTimerCount()).toBe(0);
  f.connection.stop();
});

it('resets the retry budget only after a stable connection', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.viewers[0].dispatchEvent(new Event('disconnect'));
  await vi.advanceTimersByTimeAsync(1000);
  f.viewers[1].dispatchEvent(new Event('connect'));
  await vi.advanceTimersByTimeAsync(30000);
  f.viewers[1].dispatchEvent(new Event('disconnect'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.open).toHaveBeenCalledTimes(3);
  f.connection.stop();
});

it('stops on authentication failure instead of retrying bad credentials', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.viewers[0].dispatchEvent(new Event('securityfailure'));
  f.viewers[0].dispatchEvent(new Event('disconnect'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.state).toHaveBeenLastCalledWith(
    'disconnected',
    expect.stringContaining('authentication'),
  );
  f.connection.stop();
});

it('retries a stalled RFB handshake and cancels retry timers when closed', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.release).toHaveBeenCalledOnce();
  f.connection.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts pending session requests and discards viewers arriving after unmount', async () => {
  let resolve!: (viewer: RFB) => void;
  const open = vi.fn((signal: AbortSignal) => {
    signal.throwIfAborted();
    return new Promise<RFB>((done) => (resolve = done));
  });
  const created = vi.fn();
  const release = vi.fn();
  const connection = maintainComputerConnection({ open, created, release, state: vi.fn() });
  connection.stop();
  expect(open.mock.calls[0][0].aborted).toBe(true);
  const viewer = fakeViewer();
  resolve(viewer as unknown as RFB);
  await vi.advanceTimersByTimeAsync(0);
  expect(viewer.disconnect).toHaveBeenCalledOnce();
  expect(created).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('backs off after session API errors and still permits a later successful connection', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.open.mockRejectedValueOnce(new Error('Server unavailable'));
  f.viewers[0].dispatchEvent(new Event('disconnect'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.state).toHaveBeenLastCalledWith('connecting', expect.stringContaining('Reconnecting'));
  await vi.advanceTimersByTimeAsync(2000);
  f.viewers.at(-1)!.dispatchEvent(new Event('connect'));
  expect(f.state).toHaveBeenLastCalledWith('connected', '');
  f.connection.stop();
});
