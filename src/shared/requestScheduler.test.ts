import { afterEach, expect, it, vi } from 'vitest';
import { RequestScheduler } from './requestScheduler';

const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it('bounds bursts, reserves capacity for foreground work, and prioritizes it over queued reads', async () => {
  const queue = new RequestScheduler(4, 1);
  const started: string[] = [];
  const gates = Array.from({ length: 10 }, deferred);
  const task = (id: number, background = false) =>
    queue.run(
      async () => {
        started.push(String(id));
        await gates[id].promise;
      },
      signal(),
      background ? 'background' : 'foreground',
    );
  const work = [task(0, true), task(1, true), task(2), task(3), task(4), task(5, true), task(6)];
  await vi.waitFor(() => expect(started).toEqual(['0', '2', '3', '4']));
  gates[2].resolve();
  await vi.waitFor(() => expect(started).toEqual(['0', '2', '3', '4', '6']));
  gates.forEach((gate) => gate.resolve());
  await Promise.all(work);
  expect(started).toEqual(['0', '2', '3', '4', '6', '1', '5']);
});

it('cancels queued work without executing it and releases capacity after failures', async () => {
  const queue = new RequestScheduler(1, 1);
  const gate = deferred();
  const first = queue.run(() => gate.promise, signal());
  const controller = new AbortController();
  const skipped = vi.fn();
  const canceled = queue.run(skipped, controller.signal).catch((error) => error);
  controller.abort(new Error('Left the chat'));
  expect(await canceled).toMatchObject({ message: 'Left the chat' });
  const failed = queue
    .run(async () => {
      throw new Error('offline');
    }, signal())
    .catch((error) => error);
  const next = queue.run(async () => 'ready', signal());
  gate.resolve();
  await first;
  expect(await failed).toMatchObject({ message: 'offline' });
  expect(await next).toBe('ready');
  expect(skipped).not.toHaveBeenCalled();
});

it('bounds waiting memory, expires waiting work, and rejects it on VM teardown', async () => {
  vi.useFakeTimers();
  const queue = new RequestScheduler(1, 1, 2, 100);
  const gate = deferred();
  const first = queue.run(() => gate.promise, signal());
  const skipped = vi.fn();
  const waiting = queue.run(skipped, signal()).catch((error) => error);
  const waiting2 = queue.run(skipped, signal()).catch((error) => error);
  await expect(queue.run(skipped, signal())).rejects.toThrow('queue is full');
  await vi.advanceTimersByTimeAsync(100);
  expect(await waiting).toMatchObject({ message: expect.stringContaining('busy') });
  expect(await waiting2).toMatchObject({ message: expect.stringContaining('busy') });
  const stopped = queue.run(skipped, signal()).catch((error) => error);
  queue.clear(new Error('VM stopped'));
  expect(await stopped).toMatchObject({ message: 'VM stopped' });
  gate.resolve();
  await first;
  expect(skipped).not.toHaveBeenCalled();
});
