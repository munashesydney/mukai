import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { ChatService } from '../services/chatService';

describe('remote native API authentication', () => {
  let directory: string;
  let api: Awaited<ReturnType<typeof startApiServer>>;
  let cookie: string;
  const host = 'mukai.example';
  const origin = 'https://' + host;

  // Exercise the real HTTP boundary with a public Host, as behind a TLS proxy.
  // Native calls deliberately send neither Origin nor browser session cookies.
  function call(
    path: string,
    headers: Record<string, string> = {},
    value?: unknown,
    method = value === undefined ? 'GET' : 'POST',
  ) {
    return new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
      text: string;
    }>((resolve, reject) => {
      const probe = request(
        api.url + path,
        { method, headers: { Host: host, 'Content-Type': 'application/json', ...headers } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.once('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      probe.once('error', reject);
      probe.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mukai-native-auth-'));
    const webDir = join(directory, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), '<html>Mukai</html>');
    api = await startApiServer(0, {
      dataDir: join(directory, 'data'),
      webDir,
      version: 'native-test',
    });
    const proof = await call(
      '/api/auth/verify',
      { Origin: origin },
      { code: api.ownerAuth!.setupCode },
    );
    expect(proof.status).toBe(200);
    const setup = await call(
      '/api/auth/setup',
      {
        Origin: origin,
        Cookie: proof.headers['set-cookie']![0].split(';')[0],
      },
      { username: 'owner', password: 'native authentication fixture' },
    );
    expect(setup.status).toBe(200);
    cookie = setup.headers['set-cookie']![0].split(';')[0];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (api) {
      await api.shutdown();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('allows the signed-in owner to copy API credentials while rejecting unauthenticated and foreign-origin requests', async () => {
    const signedIn = await call('/api/settings/api', { Origin: origin, Cookie: cookie });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers['cache-control']).toBe('no-store');
    expect(signedIn.headers.etag).toBeUndefined();
    expect(JSON.parse(signedIn.text)).toEqual({ token: api.token });
    const deniedHeaders: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer invalid' },
      { Origin: 'https://foreign.example', Cookie: cookie },
      { Origin: 'https://foreign.example', Authorization: `Bearer ${api.token}` },
    ];
    for (const headers of deniedHeaders) {
      const denied = await call('/api/settings/api', headers);
      expect([401, 403]).toContain(denied.status);
      expect(denied.text).not.toContain(api.token);
    }
  });

  it('validates the connection and reads/writes existing APIs with an originless bearer', async () => {
    const headers = { Authorization: `Bearer ${api.token}` };
    const instance = await call('/api/instance', headers);
    expect(instance.status).toBe(200);
    expect(JSON.parse(instance.text)).toEqual({
      instanceId: api.browserSession!.instanceId,
      version: 'native-test',
    });
    expect(instance.headers['cache-control']).toBe('no-store');
    expect(instance.headers['set-cookie']).toBeUndefined();
    expect(instance.headers['access-control-allow-origin']).toBeUndefined();

    const created = await call('/api/workspaces', headers, {
      name: 'From the native app',
      folder: directory,
    });
    expect(created.status).toBe(201);
    const workspaces = await call('/api/workspaces', headers);
    expect(workspaces.status).toBe(200);
    expect(JSON.parse(workspaces.text)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'From the native app' })]),
    );
    expect(workspaces.headers['set-cookie']).toBeUndefined();
    expect(workspaces.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects missing, invalid, and forged credentials on public native calls', async () => {
    const credentials: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer invalid' },
      { Authorization: api.token },
      { Authorization: `Bearer ${api.token}extra` },
      { 'X-Mukai-Native': 'true', 'Sec-Fetch-Site': 'none', 'X-Forwarded-For': '127.0.0.1' },
    ];
    for (const path of ['/api/instance', '/api/workspaces']) {
      for (const headers of credentials) expect((await call(path, headers)).status).toBe(401);
    }
    for (const forgedHost of ['localhost:1234', 'owner@mukai.example']) {
      expect(
        (
          await call('/api/workspaces', {
            Host: forgedHost,
            Authorization: `Bearer ${api.token}`,
          })
        ).status,
      ).toBe(403);
    }
    // The native token is not a browser bootstrap credential.
    expect((await call('/api/session', { Authorization: `Bearer ${api.token}` })).status).toBe(401);
    expect(
      (await call('/api/auth/logout', { Authorization: `Bearer ${api.token}` }, {})).status,
    ).toBe(403);
  });

  it('keeps Origin-bearing browser requests bound to their existing origin and cookie policy', async () => {
    for (const source of ['https://evil.example', 'null', 'file://']) {
      for (const path of ['/api/instance', '/api/workspaces']) {
        const response = await call(path, {
          Origin: source,
          Authorization: `Bearer ${api.token}`,
          Cookie: cookie,
          'X-Mukai-Native': 'true',
          'Sec-Fetch-Site': 'same-origin',
        });
        expect(response.status).toBe(403);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
    const preflight = await call(
      '/api/workspaces',
      {
        Origin: 'https://evil.example',
        'Access-Control-Request-Headers': 'authorization',
      },
      undefined,
      'OPTIONS',
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    for (const path of ['/api/instance', '/api/workspaces']) {
      expect(
        (await call(path, { Origin: origin, Authorization: `Bearer ${api.token}` })).status,
      ).toBe(401);
      expect((await call(path, { Origin: origin, Cookie: cookie })).status).toBe(200);
    }
  });

  it('streams authenticated SSE through the same native API boundary', async () => {
    const headers = { Authorization: `Bearer ${api.token}` };
    const folder = join(directory, 'stream-workspace');
    await mkdir(folder);
    const workspace = await call('/api/workspaces', headers, { name: 'Stream fixture', folder });
    expect(workspace.status).toBe(201);
    const bot = await call('/api/bots', headers, {
      workspaceId: JSON.parse(workspace.text).id,
      name: 'Native fixture',
      role: 'Assistant',
      instructions: 'Help the user.',
      providerId: null,
      model: null,
      supportsImages: null,
      avatar: 'nova',
    });
    expect(bot.status).toBe(201);
    // Keep generation deterministic; exercise the real route, schema and SSE
    // transport without contacting a provider or requiring a model credential.
    const respond = vi
      .spyOn(ChatService.prototype, 'respond')
      .mockImplementationOnce(async (_bot, _input, output) => {
        output.start();
        output.emit({ type: 'delta', id: 'native-reply', text: 'Native stream connected.' });
        output.end();
      });
    try {
      const input = { requestId: randomUUID(), text: 'Hello from iOS', attachmentIds: [] };
      const path = `/api/bots/${JSON.parse(bot.text).id}/chat`;
      expect((await call(path, { Accept: 'text/event-stream' }, input)).status).toBe(401);
      expect(
        (
          await call(
            path,
            {
              Authorization: `Bearer ${api.token}`,
              Origin: 'https://evil.example',
              Accept: 'text/event-stream',
            },
            input,
          )
        ).status,
      ).toBe(403);
      expect(respond).not.toHaveBeenCalled();
      const response = await call(
        path,
        {
          Authorization: `Bearer ${api.token}`,
          Accept: 'text/event-stream',
        },
        input,
      );
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['x-accel-buffering']).toBe('no');
      expect(response.text).toBe(
        'data: {"type":"delta","id":"native-reply","text":"Native stream connected."}\n\n',
      );
      expect(respond).toHaveBeenCalledOnce();
    } finally {
      respond.mockRestore();
    }
  });
});
