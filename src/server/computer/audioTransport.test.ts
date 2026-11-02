import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createServer as tcpServer, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { DesktopTransport } from './desktopTransport';
import type { QemuComputer } from './qemuComputer';
import { COMPUTER_AUDIO } from '../../shared/computerAudio';

let transport: DesktopTransport;
let server: ReturnType<typeof createServer>;
let upstream: ReturnType<typeof tcpServer>;
let connection: { port: number; key: string };
let computer: QemuComputer;
let origin: string;
let authenticated: boolean;
const sockets = new Set<Socket>();
const viewers = new Set<WebSocket>();
const receivedKeys: string[] = [];
beforeEach(async () => {
  authenticated = true;
  receivedKeys.length = 0;
  upstream = tcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (key: Buffer) => {
      receivedKeys.push(key.toString());
      socket.write('OK\n');
      // Exercise TCP coalescing: two frames must arrive together without losing samples.
      socket.write(Buffer.alloc(COMPUTER_AUDIO.frameBytes * 2, 42));
    });
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  connection = { port: (upstream.address() as { port: number }).port, key: 'a'.repeat(64) };
  computer = {
    start: vi.fn(),
    desktopConnection: () => ({ port: 1234, password: 'boot-identity' }),
    audioConnection: () => ({ ...connection }),
  } as unknown as QemuComputer;
  transport = new DesktopTransport(true, () => authenticated);
  server = createServer();
  transport.attach(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const viewer of viewers) viewer.terminate();
  viewers.clear();
  transport.shutdown();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise<void>((done) => server.close(() => done())),
    new Promise<void>((done) => upstream.close(() => done())),
  ]);
});
function viewer(path: string, requestOrigin = origin) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api' + path, {
    origin: requestOrigin,
  });
  ws.on('error', () => {});
  viewers.add(ws);
  return ws;
}
async function denied(path: string, requestOrigin = origin) {
  const ws = viewer(path, requestOrigin);
  await new Promise<void>((done, reject) => {
    ws.once('unexpected-response', (_req, response) => {
      expect(response.statusCode).toBe(403);
      response.resume();
      ws.terminate();
      done();
    });
    ws.once('open', () => reject(new Error('Unexpected audio access.')));
  });
}
it('requires single-use audio tickets, authenticates the guest privately, and delivers all coalesced PCM samples', async () => {
  const session = transport.audioSession(computer);
  expect(Object.keys(session)).toEqual(['path']);
  expect(session.path).not.toContain(connection.key);
  expect(computer.start).not.toHaveBeenCalled();
  await denied(session.path.replace('computer-audio', 'computer-view'));
  await denied(session.path, 'https://evil.example');
  const ws = viewer(session.path);
  const packets: Buffer[] = [];
  let format: unknown;
  ws.on('message', (bytes, binary) => {
    if (binary) packets.push(Buffer.from(bytes as Buffer));
    else format = JSON.parse(bytes.toString());
  });
  await expect
    .poll(() => packets.reduce((sum, packet) => sum + packet.length - 8, 0))
    .toBe(COMPUTER_AUDIO.frameBytes * 2);
  expect(format).toMatchObject({ version: 1, sampleRate: 48000, channels: 2 });
  expect(Buffer.concat(packets.map((packet) => packet.subarray(8)))).toEqual(
    Buffer.alloc(COMPUTER_AUDIO.frameBytes * 2, 42),
  );
  expect(receivedKeys).toEqual([connection.key + '\n']);
  await denied(session.path);
});
it('expires pending tickets and rejects an audio endpoint from a different boot', async () => {
  const old = transport.audioSession(computer);
  connection.key = 'b'.repeat(64);
  await denied(old.path);
  const expired = transport.audioSession(computer);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
  await denied(expired.path);
  expect(receivedKeys).toEqual([]);
});
it('keeps browser audio cookie-bound, while native tickets accept only native origins', async () => {
  authenticated = false;
  await denied(transport.audioSession(computer).path);
  const native = transport.audioSession(computer, true);
  await denied(native.path, 'https://evil.example');
  const ws = viewer(native.path, 'file://');
  await new Promise<void>((done, reject) => {
    ws.once('open', done);
    ws.once('error', reject);
  });
  await expect.poll(() => receivedKeys.length).toBe(1);
});
it('revokes live audio when authentication ends and destroys its guest connection', async () => {
  const ws = viewer(transport.audioSession(computer).path);
  await expect.poll(() => receivedKeys.length).toBe(1);
  const closed = new Promise<void>((done) => ws.once('close', () => done()));
  authenticated = false;
  await closed;
  await expect.poll(() => sockets.size).toBe(0);
}, 10000);
it('disposal closes only that workspace audio, invalidates pending tickets, and rejects viewer input', async () => {
  const ws = viewer(transport.audioSession(computer).path);
  await expect.poll(() => receivedKeys.length).toBe(1);
  const closed = new Promise<number>((done) => ws.once('close', (code) => done(code)));
  ws.send('capture microphone');
  expect(await closed).toBe(1008);
  const pending = transport.audioSession(computer);
  const next = viewer(transport.audioSession(computer).path);
  await expect.poll(() => receivedKeys.length).toBe(2);
  const disposed = new Promise<void>((done) => next.once('close', () => done()));
  transport.forget(computer);
  await disposed;
  await denied(pending.path);
});
