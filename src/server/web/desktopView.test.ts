import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { startApiServer } from '../app';
import type { QemuComputer } from '../computer/qemuComputer';
import type { ComputerViewSession } from '../../shared/computer';

let directory: string;
let api: Awaited<ReturnType<typeof startApiServer>>;
let upstream: ReturnType<typeof createServer>;
let endpoint: string;
let cookie: string;
const viewers = new Set<WebSocket>();
const start = vi.fn(async () => {});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-desktop-view-'));
  const webDir = join(directory, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<html>Viewer fixture</html>');
  upstream = createServer((socket) => {
    socket.on('error', () => {});
    socket.write('RFB fixture');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  api = await startApiServer(0, { dataDir: join(directory, 'data'), webDir });
  const workspace = api.workspaces.create({
    name: 'Viewer fixture',
    folder: '',
    computer: 'qemu',
  });
  endpoint = `/api/workspaces/${workspace.id}/computer-view`;
  vi.spyOn(api.computers, 'guest').mockReturnValue({
    start,
    desktopConnection: () => ({
      port: (upstream.address() as { port: number }).port,
      password: 'fixture',
    }),
  } as unknown as QemuComputer);
  const response = await fetch(api.url + '/api/session', {
    method: 'POST',
    headers: { Origin: api.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: api.browserSession!.connectToken }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});

afterAll(async () => {
  for (const viewer of viewers) viewer.terminate();
  vi.restoreAllMocks();
  if (api) {
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
  }
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

async function ticket(headers: Record<string, string>, reconnect = false) {
  const response = await fetch(api.url + endpoint + (reconnect ? '?reconnect=1' : ''), {
    method: 'POST',
    headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ComputerViewSession;
}

function viewer(session: ComputerViewSession, origin: string, browserCookie?: string) {
  const socket = new WebSocket(api.url.replace('http:', 'ws:') + '/api' + session.path, {
    origin,
    ...(browserCookie ? { headers: { Cookie: browserCookie } } : {}),
  });
  viewers.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => viewers.delete(socket));
  return socket;
}

async function greeting(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.once('message', (bytes) => resolve(bytes.toString()));
    socket.once('error', reject);
  });
}

async function denied(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      expect(response.statusCode).toBe(403);
      resolve();
    });
    socket.once('open', () => reject(new Error('Unexpected desktop access.')));
  });
}

it('opens and reconnects an Electron viewer without HTTP Origin alongside a browser viewer', async () => {
  const browser = viewer(await ticket({ Origin: api.url, Cookie: cookie }), api.url, cookie);
  expect(await greeting(browser)).toBe('RFB fixture');
  try {
    for (const reconnect of [false, true]) {
      // Packaged Electron omits Origin on fetch but sends file:// on WebSocket.
      const session = await ticket({ Authorization: `Bearer ${api.token}` }, reconnect);
      await denied(viewer(session, 'https://evil.example'));
      const native = viewer(session, 'file://');
      try {
        expect(await greeting(native)).toBe('RFB fixture');
        expect(browser.readyState).toBe(WebSocket.OPEN);
        await denied(viewer(session, 'file://'));
      } finally {
        native.terminate();
      }
    }
    expect(start).toHaveBeenCalledTimes(2); // Browser + first native open; reconnect never boots.
  } finally {
    browser.terminate();
  }
});

it('keeps originless cookie-authenticated tickets bound to the browser', async () => {
  const session = await ticket({ Cookie: cookie });
  await denied(viewer(session, 'file://'));
  const browser = viewer(session, api.url, cookie);
  try {
    expect(await greeting(browser)).toBe('RFB fixture');
  } finally {
    browser.terminate();
  }
});

it('rejects missing or invalid credentials and bearer requests from foreign origins', async () => {
  const requests: Record<string, string>[] = [
    {},
    { Authorization: 'Bearer invalid' },
    { Authorization: `Bearer ${api.token}`, Origin: 'https://evil.example' },
  ];
  for (const headers of requests) {
    const response = await fetch(api.url + endpoint, { method: 'POST', headers });
    expect(response.status).toBe(headers.Origin ? 403 : 401);
  }
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    const probe = request(
      api.url + endpoint,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.token}`, Host: 'localhost:1234' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    probe.once('error', reject);
    probe.end();
  });
  expect(forgedHost).toBe(403);
});
