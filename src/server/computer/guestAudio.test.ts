import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { GuestAudioServer, guestAudioKey } from './guestAudio';
import { COMPUTER_AUDIO } from '../../shared/computerAudio';

let server: GuestAudioServer;
let port: number;
const sockets = new Set<Socket>();
const key = guestAudioKey('a'.repeat(64));
let recorder: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
};
let launch: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  recorder = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      recorder.signalCode = 'SIGTERM';
      recorder.emit('exit');
      return true;
    }),
    exitCode: null,
    signalCode: null,
  });
  launch = vi.fn(() => {
    queueMicrotask(() => recorder.emit('spawn'));
    return recorder;
  });
  server = new GuestAudioServer(key, 1000, 1000, launch as unknown as typeof spawn);
  await server.listen(0, '127.0.0.1');
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await server.close();
});
async function client() {
  const socket = connect(port, '127.0.0.1');
  sockets.add(socket);
  socket.on('error', () => {});
  await new Promise<void>((done) => socket.once('connect', done));
  socket.resume();
  return socket;
}
it('rejects unauthenticated clients without launching a recorder or revealing output', async () => {
  const socket = await client();
  const received: Buffer[] = [];
  socket.on('data', (bytes) => received.push(bytes));
  const closed = new Promise<void>((done) => socket.once('close', () => done()));
  socket.write('b'.repeat(64) + '\n');
  await closed;
  expect(launch).not.toHaveBeenCalled();
  expect(received).toEqual([]);
});
it('authenticates split keys, captures only the output monitor as the guest user, and preserves frame boundaries', async () => {
  const socket = await client();
  const received: Buffer[] = [];
  socket.on('data', (bytes) => received.push(bytes));
  socket.write(key.slice(0, 20));
  expect(launch).not.toHaveBeenCalled();
  socket.write(key.slice(20) + '\n');
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  expect(launch.mock.calls[0]).toMatchObject([
    '/usr/bin/parec',
    expect.arrayContaining(['--device=mukai_output.monitor', '--channels=2', '--format=s16le']),
    { uid: 1000, gid: 1000, env: { PULSE_SERVER: 'unix:/run/mukai-audio/native' } },
  ]);
  recorder.stdout.write(Buffer.alloc(1, 12));
  recorder.stdout.write(Buffer.alloc(COMPUTER_AUDIO.frameBytes - 1, 12));
  await expect.poll(() => Buffer.concat(received).length).toBe(3 + COMPUTER_AUDIO.frameBytes);
  expect(Buffer.concat(received).subarray(0, 3).toString()).toBe('OK\n');
  expect(Buffer.concat(received).subarray(3)).toEqual(Buffer.alloc(COMPUTER_AUDIO.frameBytes, 12));
  const closed = new Promise<void>((done) => recorder.once('exit', () => done()));
  socket.destroy();
  await closed;
  expect(recorder.kill).toHaveBeenCalledOnce();
});
it('rejects oversized authentication data and any commands after authentication', async () => {
  const excessive = await client();
  const closed = new Promise<void>((done) => excessive.once('close', () => done()));
  excessive.write('x'.repeat(1000));
  await closed;
  expect(launch).not.toHaveBeenCalled();
  const socket = await client();
  socket.write(key + '\n');
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  const ended = new Promise<void>((done) => socket.once('close', () => done()));
  socket.write('capture microphone\n');
  await ended;
  expect(recorder.kill).toHaveBeenCalled();
});
it('uses distinct per-boot capture keys', () => {
  expect(guestAudioKey('b'.repeat(64))).not.toBe(key);
  expect(key).not.toBe('a'.repeat(64));
});
