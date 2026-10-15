import { expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from './app';
import type { Workspace } from '../shared/ai';

it('only creates the first workspace on request and stays empty after deleting the last one', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mukai-onboarding-')));
  const dataDir = join(directory, 'data');
  const folder = join(directory, 'project');
  await mkdir(folder);
  let api = await startApiServer(0, { dataDir });
  const request = async (path: string, method = 'GET', input?: unknown) => {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const stop = async () => {
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
  };
  try {
    expect(await request('/workspaces')).toEqual({ status: 200, data: [] });
    const created = await request('/workspaces', 'POST', { name: 'My project', folder });
    expect(created.status).toBe(201);
    const workspace = created.data as Workspace;
    expect(workspace).toMatchObject({ name: 'My project', folder, computer: 'local' });
    expect(workspace.id).not.toBe('default');
    expect((await request('/workspaces')).data).toEqual([workspace]);
    expect((await request('/bots?workspaceId=' + workspace.id)).data).toEqual([]);
    expect((await request('/memory?workspaceId=' + workspace.id)).data.settings.enabled).toBe(
      false,
    );
    await stop();
    api = await startApiServer(0, { dataDir });
    expect((await request('/workspaces')).data).toEqual([workspace]);
    expect((await request('/memory?workspaceId=' + workspace.id)).data.settings.enabled).toBe(
      false,
    );
    expect(
      (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
    ).toBe(200);
    expect((await request('/workspaces')).data).toEqual([]);
    await stop();
    api = await startApiServer(0, { dataDir });
    expect((await request('/workspaces')).data).toEqual([]);
  } finally {
    await stop();
    expect(directory.startsWith(join(tmpdir(), 'mukai-onboarding-'))).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
