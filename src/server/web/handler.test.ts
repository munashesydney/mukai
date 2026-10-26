import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startApiServer } from '../app';
import { runningServer, writeServerState } from '../../cli/serverState';
import type { DesktopUpdateState } from '../../shared/contracts';

describe('production browser server', () => {
  let directory: string;
  let api: Awaited<ReturnType<typeof startApiServer>>;
  let cookie: string;
  let updateState: DesktopUpdateState = {
    status: 'idle',
    currentVersion: '0.1.0-test',
    automaticUpdates: true,
  };
  const restart = vi.fn(async () => {
    updateState = { ...updateState, status: 'installing' };
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mukai-web-'));
    const webDir = join(directory, 'web');
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(join(webDir, 'index.html'), '<html>Mukai shared UI</html>');
    await writeFile(join(webDir, 'assets/app.js'), 'console.log("Mukai")');
    await writeFile(join(directory, 'secret.txt'), 'private');
    api = await startApiServer(0, {
      dataDir: join(directory, 'data'),
      webDir,
      version: '0.1.0-test',
      updates: {
        getState: () => ({ ...updateState }),
        check: () => (updateState = { ...updateState, status: 'checking' }),
        setAutomaticUpdates: (enabled) => {
          api.settings.saveAutomaticUpdates(enabled);
          return (updateState = { ...updateState, automaticUpdates: enabled });
        },
        restart,
      },
    });
    const response = await fetch(api.url + '/api/session', {
      method: 'POST',
      headers: { Origin: api.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: api.browserSession!.connectToken }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  });
  afterAll(async () => {
    if (api) {
      await api.shutdown();
      await new Promise<void>((done) => api.server.close(() => done()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  it('serves the UI and assets without disclosing credentials', async () => {
    const home = await fetch(api.url);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).not.toContain(api.token);
    const asset = await fetch(api.url + '/assets/app.js', { method: 'HEAD' });
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe('');
    for (const path of ['/missing.js', '/%2e%2e%2fsecret.txt', '/.env', '/%5c..%5csecret.txt'])
      expect((await fetch(api.url + path)).status).toBe(404);
  });
  it('requires authentication and preserves existing feature APIs', async () => {
    expect((await fetch(api.url + '/api/workspaces')).status).toBe(401);
    expect((await fetch(api.url + '/api/session')).status).toBe(401);
    const headers = { Cookie: cookie, Origin: api.url, 'Content-Type': 'application/json' };
    expect((await fetch(api.url + '/api/workspaces', { headers })).status).toBe(200);
    const created = await fetch(api.url + '/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Browser workspace', folder: directory }),
    });
    expect(created.ok).toBe(true);
    expect((await fetch(api.url + '/health')).status).toBe(200);
    expect(await (await fetch(api.url + '/health')).json()).toMatchObject({
      version: '0.1.0-test',
    });
  });
  it('rejects foreign origins, forged hosts, and invalid session bootstrap', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:5173'])
      expect(
        (await fetch(api.url + '/api/workspaces', { headers: { Cookie: cookie, Origin: origin } }))
          .status,
      ).toBe(403);
    const forgedHost = await new Promise<number | undefined>((done, reject) => {
      const probe = request(
        api.url + '/api/workspaces',
        { headers: { Cookie: cookie, Host: 'localhost:1234' } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      probe.once('error', reject);
      probe.end();
    });
    expect(forgedHost).toBe(403);
    expect(
      (
        await fetch(api.url + '/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'invalid' }),
        })
      ).status,
    ).toBe(401);
  });
  it('authenticates update controls, validates preferences and confirms restart after the response', async () => {
    for (const [path, method, body] of [
      ['/api/settings/updates', 'GET', undefined],
      ['/api/settings/updates', 'PUT', { enabled: false }],
      ['/api/settings/updates/check', 'POST', undefined],
      ['/api/settings/updates/restart', 'POST', { confirm: true }],
    ] as const) {
      const response = await fetch(api.url + path, {
        method,
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      expect(response.status).toBe(401);
    }
    const headers = { Cookie: cookie, Origin: api.url, 'Content-Type': 'application/json' };
    const call = (path: string, method = 'GET', value?: unknown) =>
      fetch(api.url + '/api/settings/updates' + path, {
        method,
        headers,
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
    expect(await (await call('')).json()).toMatchObject({ status: 'idle', automaticUpdates: true });
    expect((await call('', 'PUT', { enabled: 'false' })).status).toBe(400);
    expect(await (await call('', 'PUT', { enabled: false })).json()).toMatchObject({
      automaticUpdates: false,
    });
    expect(api.settings.automaticUpdates()).toBe(false);
    expect(await (await call('/check', 'POST')).json()).toMatchObject({ status: 'checking' });
    expect((await call('/restart', 'POST', { confirm: true })).status).toBe(409);
    updateState = { ...updateState, status: 'ready', version: '0.2.0' };
    expect((await call('/restart', 'POST', { confirm: false })).status).toBe(400);
    expect(restart).not.toHaveBeenCalled();
    expect(await (await call('/restart', 'POST', { confirm: true })).json()).toEqual({
      restarting: true,
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(
      (
        await fetch(api.url + '/api/settings/updates/check', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });
  it('status verifies the server instance and never trusts an arbitrary saved URL', async () => {
    const dataDir = join(directory, 'data');
    const state = {
      pid: process.pid,
      instanceId: api.browserSession!.instanceId,
      version: 'test',
      url: api.url,
      connectionUrl: `${api.url}/#mukai-connect=${api.browserSession!.connectToken}`,
    };
    await writeServerState(dataDir, state);
    expect((await runningServer(dataDir))?.instanceId).toBe(state.instanceId);
    await writeServerState(dataDir, {
      ...state,
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(await runningServer(dataDir)).toBeNull();
    await writeServerState(dataDir, { ...state, url: 'https://evil.example' });
    await expect(runningServer(dataDir)).rejects.toThrow('Invalid CLI server address');
    expect((await readFile(join(dataDir, 'api.token'))).toString('hex')).toBe(api.token);
  });
  it('renews an expired browser session without restarting the backend', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    try {
      expect((await fetch(api.url + '/api/session', { headers: { Cookie: cookie } })).status).toBe(
        401,
      );
      const renewed = await fetch(api.url + '/api/session', {
        method: 'POST',
        headers: { Origin: api.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: api.browserSession!.connectToken }),
      });
      expect(renewed.status).toBe(200);
      expect((await fetch(api.url + '/api/session', { headers: { Cookie: cookie } })).status).toBe(
        200,
      );
    } finally {
      now.mockRestore();
    }
  });
});
