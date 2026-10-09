import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDesktopBackend } from './nativeBackend';

const launcher = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: launcher }));
let directory: string;
let backend: NativeDesktopBackend;
const children: ReturnType<typeof helper>[] = [];
function helper() {
  const events = new EventEmitter();
  const frames: { id: number; action: string; text?: string }[] = [];
  const child = Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      events.emit('close', 1);
      return true;
    }),
  });
  child.stdin.on('data', (bytes: Buffer) => frames.push(JSON.parse(bytes.toString('utf8'))));
  child.stdin.on('finish', () => events.emit('close', 0));
  return { child, frames };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-native-desktop-'));
  await writeFile(join(directory, 'windows.ps1'), '# trusted fixture');
  launcher.mockImplementation(() => {
    const value = helper();
    children.push(value);
    return value.child;
  });
  backend = new NativeDesktopBackend(directory, 'win32');
});
afterEach(async () => {
  await backend.shutdown();
  await rm(directory, { recursive: true, force: true });
  children.length = 0;
  launcher.mockReset();
  vi.useRealTimers();
});

it('passes JSON on stdin, parses split UTF-8 responses and reuses the native helper', async () => {
  const pending = backend.request(
    { action: 'type', text: 'literal `$(secret)` 🌱' },
    new AbortController().signal,
  );
  const { child, frames } = children[0];
  expect(frames[0].text).toBe('literal `$(secret)` 🌱');
  const args = launcher.mock.calls[0][1] as string[];
  expect(args).not.toContain(frames[0].text);
  expect(args.at(-1)).toBe(join(directory, 'windows.ps1'));
  const bytes = Buffer.from(JSON.stringify({ id: frames[0].id, result: { value: '🌱' } }) + '\n');
  const split = bytes.indexOf(Buffer.from('🌱')) + 2;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  expect(await pending).toEqual({ value: '🌱' });
  const next = backend.request({ action: 'status' }, new AbortController().signal);
  child.stdout.write(JSON.stringify({ id: frames[1].id, result: { available: true } }) + '\n');
  expect(await next).toEqual({ available: true });
  expect(launcher).toHaveBeenCalledTimes(1);
});

it('ignores late cancelled replies and keeps the helper alive for explicit input cleanup', async () => {
  const controller = new AbortController();
  const pending = backend.request({ action: 'key', key: 'SHIFT', down: true }, controller.signal);
  const interrupted = expect(pending).rejects.toThrow('interrupted');
  controller.abort();
  await interrupted;
  const { child, frames } = children[0];
  expect(child.kill).not.toHaveBeenCalled();
  const cleanup = backend.request(
    { action: 'key', key: 'SHIFT', down: false },
    new AbortController().signal,
  );
  child.stdout.write(JSON.stringify({ id: frames[0].id, result: { late: true } }) + '\n');
  child.stdout.write(JSON.stringify({ id: frames[1].id, result: { released: true } }) + '\n');
  expect(await cleanup).toEqual({ released: true });
});

it('restarts a failed helper and rejects malformed or oversized frames', async () => {
  const pending = backend.request({ action: 'status' }, new AbortController().signal);
  const failure = expect(pending).rejects.toThrow();
  children[0].child.stdout.write('invalid json\n');
  await failure;
  const retry = backend.request({ action: 'status' }, new AbortController().signal);
  const sizeFailure = expect(retry).rejects.toThrow('size limit');
  children[1].child.stdout.write(Buffer.alloc(24 * 1024 * 1024 + 1, 65));
  await sizeFailure;
  expect(launcher).toHaveBeenCalledTimes(2);
});

it('bounds stalled primitives and starts a fresh helper for cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = backend.request({ action: 'status' }, new AbortController().signal);
  const failure = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(30000);
  await failure;
  expect(children[0].child.kill).toHaveBeenCalled();
  const cleanup = backend.request({ action: 'release' }, new AbortController().signal);
  const value = children[1];
  value.child.stdout.write(
    JSON.stringify({ id: value.frames[0].id, result: { done: true } }) + '\n',
  );
  expect(await cleanup).toEqual({ done: true });
});
