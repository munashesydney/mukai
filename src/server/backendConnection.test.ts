import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './app';
import { discoverBackend, startOrConnectBackend } from './backendConnection';
import { runningServer, publishServerState, removeServerState } from './backendState';
import { acquireDataLock } from './config';
import { serve } from '../cli/commands/serve';
import { version } from '../cli/runtime';

describe('shared backend discovery', () => {
  let directory: string;
  let webDir: string;
  const apis: Awaited<ReturnType<typeof startApiServer>>[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mukai-shared-backend-'));
    webDir = join(directory, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), '<html>Mukai</html>');
  });
  afterEach(async () => {
    for (const api of apis.splice(0)) {
      await api.shutdown();
      api.server.closeAllConnections();
      await new Promise<void>((done) => api.server.close(() => done()));
    }
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  async function start(dataDir: string) {
    const api = await startApiServer(0, { dataDir, webDir, version: 'test' });
    apis.push(api);
    return api;
  }

  it('discovers each directory at its actual ephemeral port and refuses a copied address', async () => {
    const a = join(directory, 'a');
    const b = join(directory, 'b');
    const first = await start(a);
    const second = await start(b);
    expect(first.url).not.toBe(second.url);
    expect((await discoverBackend(a, 'test'))?.state.url).toBe(first.url);
    expect((await discoverBackend(b, 'test'))?.state.url).toBe(second.url);
    // A saved address/identity is insufficient without the selected directory's credential.
    publishServerState(b, first.state!);
    expect(await discoverBackend(b, 'test')).toBeNull();
    publishServerState(b, second.state!);
    const shouldNotStart = vi.fn();
    const result = await startOrConnectBackend(b, 'test', shouldNotStart);
    expect(result).toMatchObject({ owned: false, connection: { state: { url: second.url } } });
    expect(shouldNotStart).not.toHaveBeenCalled();
  });

  it('starts only one backend when launchers race for the same directory', async () => {
    const dataDir = join(directory, 'race');
    const results = await Promise.all([
      startOrConnectBackend(dataDir, 'test', () => start(dataDir)),
      startOrConnectBackend(dataDir, 'test', () => start(dataDir)),
    ]);
    expect(results.filter((result) => result.owned)).toHaveLength(1);
    expect(results.filter((result) => !result.owned)).toHaveLength(1);
    const attached = results.find((result) => !result.owned)!;
    if (attached.owned) throw new Error('Expected an attached client');
    expect(attached.connection.state.url).toBe(apis[0].url);
  });

  it('reuses serve on another requested port and exits without taking shutdown ownership', async () => {
    const dataDir = join(directory, 'serve');
    const api = await startApiServer(0, { dataDir, webDir, version: version() });
    apis.push(api);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await serve({ command: 'serve', dataDir, port: 47831, open: false });
    expect(result.reused).toBe(true);
    expect(result).not.toHaveProperty('stop');
    expect(log.mock.calls.flat().join('\n')).toContain('Requested port 47831');
    expect((await runningServer(dataDir))?.instanceId).toBe(api.state!.instanceId);
    const ephemeral = await serve({ command: 'serve', dataDir, port: 0, open: false });
    expect(ephemeral.connectionUrl).toBe(api.state!.connectionUrl);
    expect((await fetch(api.url + '/health')).ok).toBe(true);
  });

  it('rejects version mismatches without opening the database or replacing the server', async () => {
    const dataDir = join(directory, 'version');
    const api = await start(dataDir);
    const startAgain = vi.fn();
    await expect(startOrConnectBackend(dataDir, 'different', startAgain)).rejects.toThrow(
      'Update both to the same version',
    );
    expect(startAgain).not.toHaveBeenCalled();
    expect((await runningServer(dataDir))?.instanceId).toBe(api.state!.instanceId);
  });

  it('never steals an unverified live lock while waiting for readiness', async () => {
    const dataDir = join(directory, 'locked');
    const release = acquireDataLock(dataDir);
    try {
      await expect(
        startOrConnectBackend(dataDir, 'test', () => start(dataDir), 10),
      ).rejects.toThrow('did not become ready');
      expect(await readFile(join(dataDir, 'server.lock'), 'utf8')).toBe(String(process.pid));
    } finally {
      release();
    }
  });

  it('removes discovery before releasing the lock and protects replacement state from old cleanup', async () => {
    const dataDir = join(directory, 'restart');
    const api = await start(dataDir);
    const oldId = api.state!.instanceId;
    await api.shutdown();
    await new Promise<void>((done) => api.server.close(() => done()));
    apis.splice(apis.indexOf(api), 1);
    expect(await runningServer(dataDir)).toBeNull();
    await expect(readFile(join(dataDir, 'server.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const replacement = await start(dataDir);
    await removeServerState(dataDir, oldId);
    expect((await runningServer(dataDir))?.instanceId).toBe(replacement.state!.instanceId);
  });
});
