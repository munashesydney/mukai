import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { relayAudioStream } from './audioStream';
import { COMPUTER_AUDIO } from '../../shared/computerAudio';

afterEach(() => vi.useRealTimers());
it('drops excess PCM while a write is blocked, resumes with fresh audio, and closes on heartbeat loss', () => {
  vi.useFakeTimers();
  const sends: Buffer[] = [];
  let drained: ((error?: Error) => void) | undefined;
  const viewer = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((value: unknown, _options?: unknown, callback?: (error?: Error) => void) => {
      if (Buffer.isBuffer(value)) {
        sends.push(value);
        drained = callback;
      }
    }),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
  });
  const upstream = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
  relayAudioStream(viewer as unknown as WebSocket, upstream as unknown as Socket, 'secret-key');
  upstream.emit('connect');
  expect(upstream.write).toHaveBeenCalledWith('secret-key\n');
  upstream.emit('data', Buffer.from('OK\n'));
  for (let i = 0; i < 100; i++)
    upstream.emit('data', Buffer.alloc(COMPUTER_AUDIO.frameBytes * 2, i));
  expect(sends).toHaveLength(1);
  expect(sends[0].length).toBe(8 + COMPUTER_AUDIO.frameBytes * 2);
  drained?.();
  upstream.emit('data', Buffer.alloc(COMPUTER_AUDIO.frameBytes, 101));
  expect(sends).toHaveLength(2);
  expect(sends[1].subarray(8)).toEqual(Buffer.alloc(COMPUTER_AUDIO.frameBytes, 101));
  vi.advanceTimersByTime(14000);
  expect(viewer.close).toHaveBeenCalledWith(1013, 'Audio delivery stalled.');
  expect(upstream.destroy).toHaveBeenCalled();
  viewer.emit('close');
  expect(vi.getTimerCount()).toBe(0);
});
