import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, Frames } from './protocol';
import { GuestTransport, openGuestChannel, type GuestChannel } from './guestTransport';

const transports: GuestTransport[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  vi.useRealTimers();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function channel() {
  const reader = new PassThrough();
  const sent: unknown[] = [];
  const frames = new Frames();
  const writer = new Writable({
    write(chunk: Buffer, _encoding, done) {
      sent.push(...frames.push(chunk));
      done();
    },
  });
  const close = vi.fn(() => {
    reader.destroy();
    writer.destroy();
  });
  return { reader, writer, sent, close };
}
function fixture() {
  const channels: ReturnType<typeof channel>[] = [];
  const onFrame = vi.fn();
  const onReady = vi.fn();
  const open = vi.fn((): GuestChannel => {
    const result = channel();
    channels.push(result);
    return result;
  });
  const transport = new GuestTransport({
    open,
    hello: { hello: 1, token: 'boot-identity' },
    onFrame,
    onReady,
  });
  transports.push(transport);
  transport.start();
  return { transport, channels, open, onFrame, onReady };
}

it('reauthenticates after EOF without replaying requests and delivers completed pending replies', async () => {
  const { transport, channels, open, onFrame, onReady } = fixture();
  channels[0].reader.write(encodeFrame({ ready: 1 }));
  channels[0].reader.write(encodeFrame({ id: 'once', method: 'terminal' }));
  expect(onFrame).toHaveBeenCalledOnce();
  channels[0].reader.end();
  await tick();
  expect(transport.ready).toBe(false);
  expect(transport.send({ id: 'once', result: 'completed while reconnecting' })).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(open).toHaveBeenCalledTimes(2);
  expect(channels[1].sent).toEqual([{ hello: 1, token: 'boot-identity' }]);
  channels[1].reader.write(encodeFrame({ ready: 1 }));
  await tick();
  expect(channels[1].sent).toContainEqual({ id: 'once', result: 'completed while reconnecting' });
  expect(onReady).toHaveBeenCalledTimes(2);
  expect(onFrame).toHaveBeenCalledOnce();
});

it('continues bounded hello announcements after ready for transparent QEMU backend reconnects', async () => {
  const { transport, channels, open } = fixture();
  expect(transport.send({ telemetry: {} }, true)).toBe(false);
  channels[0].reader.write(encodeFrame({ ready: 1 }));
  await vi.advanceTimersByTimeAsync(5500);
  expect(
    channels[0].sent.filter((frame) => frame && typeof frame === 'object' && 'hello' in frame),
  ).toHaveLength(3);
  expect(open).toHaveBeenCalledOnce();
});

it('resets partial framing on stream errors and ignores events from the previous channel', async () => {
  const { transport, channels, onFrame } = fixture();
  channels[0].reader.write(encodeFrame({ ready: 1 }));
  channels[0].reader.write('{"partial":');
  channels[0].reader.emit('error', new Error('backend disconnected'));
  expect(channels[0].close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(250);
  channels[1].reader.write(encodeFrame({ ready: 1 }));
  channels[0].reader.emit('data', encodeFrame({ id: 'stale' }));
  channels[1].reader.write(encodeFrame({ id: 'new' }));
  expect(transport.ready).toBe(true);
  expect(onFrame.mock.calls).toEqual([[{ id: 'new' }]]);
});

it('limits offline response buffering and cancels retry timers on shutdown', async () => {
  const { transport, channels, open } = fixture();
  for (let id = 0; id < 32; id++) expect(transport.send({ id })).toBe(true);
  expect(transport.send({ id: 33 })).toBe(false);
  channels[0].reader.emit('error', new Error('disconnected'));
  transport.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(open).toHaveBeenCalledOnce();
  expect(transport.send({ id: 34 })).toBe(false);
});

it('backs off repeated device-open failures to a bounded five-second retry interval', async () => {
  const open = vi.fn(() => {
    throw new Error('device unavailable');
  });
  const transport = new GuestTransport({ open, hello: {}, onFrame: () => {} });
  transports.push(transport);
  transport.start();
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(250);
  expect(open).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000);
  expect(open).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(4999);
  expect(open).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(7);
});

it('closes its shared descriptor once after both streams finish pending filesystem I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-channel-'));
  const file = join(directory, 'serial-stand-in');
  await writeFile(file, Buffer.alloc(128 * 1024));
  const channel = openGuestChannel(file);
  const closed = Promise.all([once(channel.reader, 'close'), once(channel.writer, 'close')]);
  try {
    channel.reader.on('data', () => {});
    channel.writer.write('test');
    channel.close();
    channel.close();
    await closed;
  } finally {
    channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
