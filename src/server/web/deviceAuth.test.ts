import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startApiServer } from '../app';
import { ChatService } from '../services/chatService';
import type { QemuComputer } from '../computer/qemuComputer';
import type { OwnerDeviceSession } from '../../shared/ownerAuth';

type Api = Awaited<ReturnType<typeof startApiServer>>;
const login = { username: 'owner+device@example.com', password: 'a native owner passphrase' };
const host = 'mukai.example';
const origin = 'https://' + host;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function call(
  api: Api,
  path: string,
  value?: unknown,
  headers: Record<string, string> = {},
  method = value === undefined ? 'GET' : 'POST',
) {
  return new Promise<{
    status: number;
    body: Record<string, unknown>;
    headers: IncomingMessage['headers'];
  }>((resolve, reject) => {
    const probe = httpRequest(
      api.url + path,
      {
        method,
        headers: { Host: host, 'Content-Type': 'application/json', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
              headers: response.headers,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    probe.once('error', reject);
    probe.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

async function setup(api: Api) {
  const proof = await call(
    api,
    '/api/auth/verify',
    { code: api.ownerAuth!.setupCode },
    { Origin: origin },
  );
  expect(proof.status).toBe(200);
  const result = await call(api, '/api/auth/setup', login, {
    Origin: origin,
    Cookie: proof.headers['set-cookie']![0].split(';')[0],
  });
  expect(result.status).toBe(200);
  return result.headers['set-cookie']![0].split(';')[0];
}
async function device(api: Api) {
  const result = await call(api, '/api/auth/device', login, {
    Authorization: 'Bearer cloudflare-access-fixture',
  });
  expect(result.status).toBe(200);
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(result.headers['cache-control']).toBe('no-store');
  return result.body as unknown as OwnerDeviceSession;
}

describe('owner device sessions', () => {
  let root: string;
  let webDir: string;
  let api: Api;
  let browserCookie: string;
  const servers: Api[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mukai-device-auth-'));
    webDir = join(root, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), '<html>Mukai fixture</html>');
    api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
    servers.push(api);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      await server.shutdown();
      await new Promise<void>((resolve) => server.server.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  it('requires browser owner setup and accepts only originless device login/logout', async () => {
    const unset = await call(api, '/api/auth/device', login);
    expect(unset.status).toBe(409);
    expect(unset.body.error).toContain('Set up an owner account');
    expect(api.store.get('SELECT COUNT(*) AS count FROM web_owner')!.count).toBe(0);
    await setup(api);
    for (const source of [origin, 'https://evil.example', 'null', 'file://', '']) {
      for (const action of ['device', 'device-logout']) {
        expect((await call(api, '/api/auth/' + action, login, { Origin: source })).status).toBe(
          403,
        );
      }
    }
    expect((await call(api, '/api/auth/device', login, { Host: 'localhost:1234' })).status).toBe(
      403,
    );
    expect((await call(api, '/api/auth/device')).status).toBe(405);
    expect((await call(api, '/api/auth/device', { ...login, extra: 'ignored?' })).status).toBe(400);
  });

  it('issues a separate seven-day hashed session and leaves Authorization free for Access', async () => {
    browserCookie = await setup(api);
    const before = Date.now();
    const session = await device(api);
    expect(session).toEqual({
      authenticated: true,
      sessionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: expect.any(String),
    });
    expect(session.sessionToken).not.toBe(api.token);
    expect(Date.parse(session.expiresAt)).toBeGreaterThanOrEqual(before + 7 * 86400_000);
    expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(Date.now() + 7 * 86400_000);
    const rows = api.store.all('SELECT token_hash,expires_at FROM web_sessions');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token_hash: digest('mukai-device:' + session.sessionToken),
          expires_at: Date.parse(session.expiresAt),
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(session.sessionToken);
    expect(JSON.stringify(rows)).not.toContain(login.password);
    const headers = {
      'X-Mukai-Session': session.sessionToken,
      Authorization: 'Bearer cloudflare-access-fixture',
    };
    expect((await call(api, '/api/auth/status', undefined, headers)).body).toEqual({
      configured: true,
      authenticated: true,
      verified: false,
    });
    expect((await call(api, '/api/instance', undefined, headers)).status).toBe(200);
    expect((await call(api, '/api/workspaces', undefined, headers)).status).toBe(200);
    const created = await call(
      api,
      '/api/workspaces',
      { name: 'Device workspace', folder: root },
      headers,
    );
    expect(created.status).toBe(201);
    expect(created.headers['set-cookie']).toBeUndefined();
    expect(
      (await call(api, '/api/workspaces', undefined, { Origin: origin, Cookie: browserCookie }))
        .status,
    ).toBe(200);
    expect(
      (await call(api, '/api/workspaces', undefined, { Authorization: `Bearer ${api.token}` }))
        .status,
    ).toBe(200);
  });

  it('does not interchange device credentials with browser cookies or API tokens', async () => {
    browserCookie = await setup(api);
    const session = await device(api);
    const browserToken = browserCookie.slice(browserCookie.indexOf('=') + 1);
    const cookieName = browserCookie.slice(0, browserCookie.indexOf('='));
    for (const token of ['invalid', browserToken, api.token]) {
      const headers = { 'X-Mukai-Session': token };
      expect((await call(api, '/api/workspaces', undefined, headers)).status).toBe(401);
      expect((await call(api, '/api/auth/status', undefined, headers)).body.authenticated).toBe(
        false,
      );
    }
    expect(
      (
        await call(api, '/api/workspaces', undefined, {
          Cookie: `${cookieName}=${session.sessionToken}`,
          Origin: origin,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(api, '/api/workspaces', undefined, {
          Authorization: `Bearer ${session.sessionToken}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(api, '/api/workspaces', undefined, {
          'X-Mukai-Session': session.sessionToken,
          Origin: origin,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(api, '/api/auth/status', undefined, {
          'X-Mukai-Session': session.sessionToken,
          Origin: origin,
        })
      ).body.authenticated,
    ).toBe(false);
    for (const source of ['https://evil.example', 'null', 'file://']) {
      expect(
        (
          await call(api, '/api/workspaces', undefined, {
            'X-Mukai-Session': session.sessionToken,
            Origin: source,
            Cookie: browserCookie,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await call(api, '/api/workspaces', undefined, {
          'X-Mukai-Session': session.sessionToken,
          Host: 'localhost:1234',
        })
      ).status,
    ).toBe(403);
  });

  it('rejects wrong credentials and shares browser/device guessing limits', async () => {
    await setup(api);
    for (let attempt = 0; attempt < 10; attempt++) {
      const browser = attempt % 2 === 0;
      const result = await call(
        api,
        browser ? '/api/auth/login' : '/api/auth/device',
        {
          username: attempt % 3 ? login.username : 'not-the-owner',
          password: 'wrong',
        },
        browser ? { Origin: origin } : {},
      );
      expect(result.status).toBe(401);
      expect(result.body.error).toBe('The username or password is incorrect.');
    }
    expect((await call(api, '/api/auth/device', login)).status).toBe(429);
    expect((await call(api, '/api/auth/login', login, { Origin: origin })).status).toBe(429);
    expect(api.store.get('SELECT COUNT(*) AS count FROM web_sessions')!.count).toBe(1);
  }, 12000);

  it('revokes one device session without revoking other devices or browser login', async () => {
    browserCookie = await setup(api);
    const first = await device(api),
      second = await device(api);
    expect(first.sessionToken).not.toBe(second.sessionToken);
    const logout = await call(
      api,
      '/api/auth/device-logout',
      {},
      { 'X-Mukai-Session': first.sessionToken },
    );
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ authenticated: false });
    expect(logout.headers['set-cookie']).toBeUndefined();
    expect(
      (await call(api, '/api/workspaces', undefined, { 'X-Mukai-Session': first.sessionToken }))
        .status,
    ).toBe(401);
    expect(
      (await call(api, '/api/auth/status', undefined, { 'X-Mukai-Session': first.sessionToken }))
        .body.authenticated,
    ).toBe(false);
    expect(
      (await call(api, '/api/workspaces', undefined, { 'X-Mukai-Session': second.sessionToken }))
        .status,
    ).toBe(200);
    expect(
      (await call(api, '/api/workspaces', undefined, { Origin: origin, Cookie: browserCookie }))
        .status,
    ).toBe(200);
    expect((await call(api, '/api/auth/device-logout', {})).status).toBe(401);
    expect(
      (
        await call(
          api,
          '/api/auth/device-logout',
          {},
          { 'X-Mukai-Session': browserCookie.split('=')[1] },
        )
      ).status,
    ).toBe(401);
    expect(
      (await call(api, '/api/auth/logout', {}, { Origin: origin, Cookie: browserCookie })).status,
    ).toBe(200);
    expect(
      (await call(api, '/api/workspaces', undefined, { 'X-Mukai-Session': second.sessionToken }))
        .status,
    ).toBe(200);
    expect(
      (await call(api, '/api/workspaces', undefined, { Origin: origin, Cookie: browserCookie }))
        .status,
    ).toBe(401);
  });

  it('persists across restart, expires after seven days, and is scoped to its instance', async () => {
    await setup(api);
    const session = await device(api);
    const other = await startApiServer(0, { dataDir: join(root, 'other-data'), webDir });
    servers.push(other);
    await setup(other);
    const headers = { 'X-Mukai-Session': session.sessionToken };
    expect((await call(other, '/api/workspaces', undefined, headers)).status).toBe(401);
    expect((await call(other, '/api/auth/status', undefined, headers)).body.authenticated).toBe(
      false,
    );
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    servers.splice(servers.indexOf(api), 1);
    api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
    servers.push(api);
    expect((await call(api, '/api/workspaces', undefined, headers)).status).toBe(200);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(session.expiresAt));
    try {
      expect((await call(api, '/api/workspaces', undefined, headers)).status).toBe(401);
      expect((await call(api, '/api/auth/status', undefined, headers)).body.authenticated).toBe(
        false,
      );
      expect((await call(api, '/api/auth/device-logout', {}, headers)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it('terminates a native SSE stream when its session is revoked', async () => {
    await setup(api);
    const session = await device(api);
    const headers = { 'X-Mukai-Session': session.sessionToken };
    const workspace = await call(
      api,
      '/api/workspaces',
      { name: 'Streaming fixture', folder: root },
      headers,
    );
    const bot = await call(
      api,
      '/api/bots',
      {
        workspaceId: workspace.body.id,
        name: 'Scout',
        role: 'Assistant',
        instructions: 'Help the user.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'scout',
      },
      headers,
    );
    expect(bot.status).toBe(201);
    let disconnect: (() => void) | undefined;
    const disconnected = vi.fn();
    let onServerClose: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      onServerClose = resolve;
    });
    vi.spyOn(ChatService.prototype, 'respond').mockImplementationOnce(
      async (_bot, _input, output) => {
        output.start();
        output.emit({ type: 'delta', id: 'stream', text: 'Connected.' });
        await new Promise<void>((resolve) => {
          disconnect = resolve;
          output.onDisconnect(() => {
            disconnected();
            onServerClose();
            resolve();
          });
        });
        output.end();
      },
    );
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const probe = httpRequest(
        api.url + `/api/bots/${bot.body.id}/chat`,
        {
          method: 'POST',
          headers: {
            Host: host,
            ...headers,
            Authorization: 'Bearer access-fixture',
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
        },
        resolve,
      );
      probe.once('error', reject);
      probe.end(JSON.stringify({ requestId: randomUUID(), text: 'Keep open', attachmentIds: [] }));
    });
    response.on('error', () => {});
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      response.resume();
      expect((await call(api, '/api/auth/device-logout', {}, headers)).status).toBe(200);
      await closed;
      await serverClosed;
      expect(disconnected).toHaveBeenCalledOnce();
    } finally {
      response.destroy();
      disconnect?.();
    }
  }, 12000);

  it('does not give device sessions local renderer or cookie-only WebSocket privileges', async () => {
    browserCookie = await setup(api);
    const session = await device(api);
    const upstream = createNetServer((socket) => {
      socket.on('error', () => {});
      socket.write('RFB fixture');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const workspace = api.workspaces.create({
      name: 'Viewer fixture',
      folder: '',
      computer: 'qemu',
    });
    vi.spyOn(api.computers, 'guest').mockReturnValue({
      start: async () => {},
      desktopConnection: () => ({
        port: (upstream.address() as { port: number }).port,
        password: 'fixture',
      }),
    } as unknown as QemuComputer);
    const ticket = await call(
      api,
      `/api/workspaces/${workspace.id}/computer-view`,
      {},
      { 'X-Mukai-Session': session.sessionToken },
    );
    expect(ticket.status).toBe(200);
    const url = api.url.replace('http:', 'ws:') + '/api' + ticket.body.path;
    const sockets: WebSocket[] = [];
    try {
      for (const source of ['file://', api.url]) {
        const viewer = new WebSocket(url, {
          origin: source,
          headers: { 'X-Mukai-Session': session.sessionToken },
        });
        sockets.push(viewer);
        viewer.on('error', () => {});
        expect(
          await new Promise<number>((resolve) =>
            viewer.once('unexpected-response', (_request, response) => {
              response.resume();
              resolve(response.statusCode!);
            }),
          ),
        ).toBe(403);
        viewer.terminate();
      }
      const browser = new WebSocket(url, { origin: api.url, headers: { Cookie: browserCookie } });
      sockets.push(browser);
      browser.on('error', () => {});
      expect(
        await new Promise<string>((resolve, reject) => {
          browser.once('message', (value) => resolve(value.toString()));
          browser.once('error', reject);
        }),
      ).toBe('RFB fixture');
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
