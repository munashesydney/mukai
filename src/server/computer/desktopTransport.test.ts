import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { WebSocket } from 'ws';
import { DesktopTransport } from './desktopTransport';
import type { QemuComputer } from './qemuComputer';

let transport: DesktopTransport;
let server: ReturnType<typeof createServer>;
let upstream: ReturnType<typeof createTcpServer>;
let url: string;
let connection: { port: number; password: string };
let computer: QemuComputer;
let upstreamErrors: NodeJS.ErrnoException[];
beforeEach(async () => {
  upstreamErrors = [];
  upstream = createTcpServer((socket) => {
    // Revoking a viewer can reset the fixture's TCP connection during its greeting.
    socket.on('error', (error: NodeJS.ErrnoException) => upstreamErrors.push(error));
    socket.write('RFB fixture');
    socket.on('data', (bytes) => socket.write(bytes));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  connection = { port: (upstream.address() as { port: number }).port, password: 'temporary' };
  computer = {
    start: async () => {},
    desktopConnection: () => ({ ...connection }),
  } as unknown as QemuComputer;
  transport = new DesktopTransport();
  server = createServer();
  transport.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  transport.shutdown();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
  for (const error of upstreamErrors) expect(error.code).toBe('ECONNRESET');
});
async function denied(path: string, origin?: string) {
  const socket = new WebSocket(url + path, { origin });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      expect(response.statusCode).toBe(403);
      response.resume();
      socket.terminate();
      resolve();
    });
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('Unexpected access to desktop.'));
    });
  });
}
it('requires a fresh ticket, protects origins, and invalidates tickets after a VM restart', async () => {
  await denied('/computer-view');
  const session = await transport.session(computer);
  await denied(session.path, 'https://untrusted.example');
  connection.password = 'new-boot';
  await denied(session.path, 'null');
});
it('streams binary desktop data and consumes each ticket exactly once', async () => {
  const session = await transport.session(computer);
  const viewer = new WebSocket(url + session.path, { origin: 'file://' });
  const messages: string[] = [];
  viewer.on('message', (bytes) => messages.push(bytes.toString()));
  await new Promise<void>((resolve, reject) => {
    viewer.once('open', resolve);
    viewer.once('error', reject);
  });
  try {
    await expect.poll(() => messages.join('')).toContain('RFB fixture');
    viewer.send(Buffer.from('input'));
    await expect.poll(() => messages.join('')).toContain('input');
    await denied(session.path, 'null');
  } finally {
    viewer.terminate();
  }
});
it('expires unused viewer tickets', async () => {
  const session = await transport.session(computer);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
  await denied(session.path, 'file://');
});
it('carries a full 1 MiB clipboard update with its RFB headers', async () => {
  const session = await transport.session(computer);
  const viewer = new WebSocket(url + session.path, { origin: 'file://' });
  const received: Buffer[] = [];
  viewer.on('message', (bytes) => received.push(Buffer.from(bytes as Buffer)));
  await new Promise<void>((done, reject) => {
    viewer.once('open', done);
    viewer.once('error', reject);
  });
  try {
    await expect.poll(() => Buffer.concat(received).toString()).toBe('RFB fixture');
    received.length = 0;
    const payload = Buffer.alloc(1024 * 1024 + 8, 65);
    viewer.send(payload);
    await expect.poll(() => Buffer.concat(received).length).toBe(payload.length);
    expect(Buffer.concat(received).equals(payload)).toBe(true);
  } finally {
    viewer.terminate();
  }
});
it('browser mode streams the API websocket on its selected origin and rejects the dev origin', async () => {
  transport.shutdown();
  server.removeAllListeners('upgrade');
  transport = new DesktopTransport(true);
  transport.attach(server);
  const session = await transport.session(computer);
  await denied('/api' + session.path, 'http://127.0.0.1:5173');
  const viewer = new WebSocket(url + '/api' + session.path, {
    origin: url.replace('ws:', 'http:'),
  });
  try {
    await new Promise<void>((done, reject) => {
      viewer.once('open', done);
      viewer.once('error', reject);
    });
  } finally {
    viewer.terminate();
  }
});
it('keeps the existing desktop available when only the guest bridge disconnects', async () => {
  vi.spyOn(computer, 'start').mockRejectedValue(new Error('Guest bridge disconnected'));
  await expect(transport.session(computer)).resolves.toMatchObject({ password: 'temporary' });
});
it('requires browser authentication and revokes live desktop access when a session ends', async () => {
  transport.shutdown();
  server.removeAllListeners('upgrade');
  let authenticated = false;
  transport = new DesktopTransport(true, () => authenticated);
  transport.attach(server);
  const session = await transport.session(computer);
  await denied('/api' + session.path, url.replace('ws:', 'http:'));
  authenticated = true;
  const viewer = new WebSocket(url + '/api' + session.path, {
    origin: url.replace('ws:', 'http:'),
  });
  await new Promise<void>((done, reject) => {
    viewer.once('open', done);
    viewer.once('error', reject);
  });
  const closed = new Promise<void>((done) => viewer.once('close', () => done()));
  authenticated = false;
  await closed;
}, 10000);
it('preserves the startup error when the guest has no usable desktop endpoint', async () => {
  vi.spyOn(computer, 'start').mockRejectedValue(new Error('Linux guest crashed (kernel panic)'));
  vi.spyOn(computer, 'desktopConnection').mockImplementation(() => {
    throw new Error('Desktop unavailable');
  });
  await expect(transport.session(computer)).rejects.toThrow('kernel panic');
});

it('revokes only the disposed computer tickets and closes its connected viewer', async () => {
  const ticket = await transport.session(computer);
  const viewer = new WebSocket(url + ticket.path, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    viewer.once('open', resolve);
    viewer.once('error', reject);
  });
  const pending = await transport.session(computer);
  const other = {
    start: async () => {},
    desktopConnection: () => ({ ...connection }),
  } as unknown as QemuComputer;
  const otherTicket = await transport.session(other);
  const closed = new Promise<void>((resolve) => viewer.once('close', () => resolve()));
  transport.forget(computer);
  await closed;
  await denied(pending.path);
  expect(otherTicket.password).toBe('temporary');
  const otherViewer = new WebSocket(url + otherTicket.path, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    otherViewer.once('open', resolve);
    otherViewer.once('error', reject);
  });
  otherViewer.terminate();
});
