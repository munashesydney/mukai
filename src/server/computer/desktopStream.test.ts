import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { relayDesktopStream } from './desktopStream';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const writes: { bytes: Buffer; done(error?: Error): void }[] = [];
  const viewer = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: vi.fn((bytes: Buffer, _options: unknown, done: (error?: Error) => void) => {
      writes.push({ bytes, done });
    }),
    ping: vi.fn((_payload: Buffer, _mask: boolean, done: (error?: Error) => void) => done()),
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(() => (viewer.readyState = WebSocket.CLOSING)),
    terminate: vi.fn(() => {
      viewer.readyState = WebSocket.CLOSED;
      viewer.emit('close');
    }),
  });
  const upstream = Object.assign(new EventEmitter(), {
    writableLength: 0,
    write: vi.fn((bytes: Buffer) => bytes.length > 0),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  });
  const report = vi.fn();
  relayDesktopStream(viewer as unknown as WebSocket, upstream as unknown as Socket, report);
  const pong = () => viewer.emit('pong', viewer.ping.mock.lastCall![0]);
  return { viewer, upstream, report, writes, pong };
}

it('pauses the VM stream until each display write drains and preserves every byte', () => {
  const f = fixture();
  const first = Buffer.from([0, 255, 3, 10]);
  f.upstream.emit('data', first);
  expect(f.upstream.pause).toHaveBeenCalledOnce();
  expect(f.upstream.resume).not.toHaveBeenCalled();
  expect(f.writes[0].bytes).toBe(first);
  f.writes[0].done();
  expect(f.upstream.resume).toHaveBeenCalledOnce();
  const second = Buffer.alloc(65536, 123);
  f.upstream.emit('data', second);
  f.writes[1].done();
  expect(Buffer.concat(f.writes.map((write) => write.bytes))).toEqual(
    Buffer.concat([first, second]),
  );
  expect(f.upstream.resume).toHaveBeenCalledTimes(2);
  f.viewer.terminate();
});

it('applies input backpressure without truncating a large clipboard payload', () => {
  const f = fixture();
  f.upstream.write.mockReturnValue(false);
  const clipboard = Buffer.alloc(1024 * 1024 + 8, 65);
  f.viewer.emit('message', clipboard, true);
  expect(f.upstream.write).toHaveBeenCalledWith(clipboard);
  expect(f.viewer.pause).toHaveBeenCalledOnce();
  expect(f.viewer.resume).not.toHaveBeenCalled();
  f.upstream.emit('drain');
  expect(f.viewer.resume).toHaveBeenCalledOnce();
  f.viewer.terminate();
  f.upstream.emit('drain');
  expect(f.viewer.resume).toHaveBeenCalledOnce();
});

it('keeps an idle responsive connection alive without requiring display updates', () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(2000);
    f.pong();
  }
  expect(f.viewer.ping).toHaveBeenCalledTimes(40);
  expect(f.viewer.close).not.toHaveBeenCalled();
  f.viewer.terminate();
  expect(vi.getTimerCount()).toBe(0);
});

it('recovers when a proxy stops delivering heartbeats even with an empty local queue', () => {
  const f = fixture();
  vi.advanceTimersByTime(2000);
  f.viewer.emit('pong', Buffer.from('unsolicited'));
  vi.advanceTimersByTime(10000);
  expect(f.report).toHaveBeenCalledWith('heartbeat-timeout', 0, 0);
  expect(f.upstream.destroy).toHaveBeenCalledOnce();
  expect(f.viewer.close).toHaveBeenCalledWith(1013, expect.any(String));
  vi.advanceTimersByTime(1000);
  expect(f.viewer.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('recovers sustained added latency but tolerates one slow probe', () => {
  const f = fixture();
  vi.advanceTimersByTime(2000);
  f.pong();
  vi.advanceTimersByTime(2000);
  vi.advanceTimersByTime(2500);
  f.pong();
  expect(f.viewer.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1500);
  f.pong(); // A fast probe resets the consecutive-slow counter.
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2500);
    f.pong();
  }
  expect(f.report).toHaveBeenCalledWith('sustained-latency', expect.any(Number), 0);
  expect(f.viewer.close).toHaveBeenCalledOnce();
  f.viewer.terminate();
});

it('does not repeatedly reconnect a client whose baseline RTT is naturally high', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2500);
    f.pong();
  }
  expect(f.viewer.close).not.toHaveBeenCalled();
  f.viewer.terminate();
});

it('times out a blocked local write and never resumes a closed upstream', () => {
  const f = fixture();
  f.upstream.emit('data', Buffer.alloc(65536));
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(2000);
    f.pong();
  }
  expect(f.report).toHaveBeenCalledWith('write-timeout', expect.any(Number), 0);
  f.writes[0].done();
  expect(f.upstream.resume).not.toHaveBeenCalled();
  f.viewer.terminate();
});

it('closes on write errors and rejects nonbinary input', () => {
  const f = fixture();
  f.upstream.emit('data', Buffer.from('frame'));
  f.writes[0].done(new Error('socket closed'));
  expect(f.viewer.close).toHaveBeenCalledWith(1011, expect.any(String));
  f.viewer.terminate();
  const invalid = fixture();
  invalid.viewer.emit('message', Buffer.from('text'), false);
  expect(invalid.viewer.close).toHaveBeenCalledWith(1008, expect.any(String));
  expect(invalid.upstream.write).not.toHaveBeenCalled();
  invalid.viewer.terminate();
});
