import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from '../app';
import type { Workspace, ToolInfo } from '../../shared/ai';
import { buildBotSystemPrompt } from '../../shared/botSystemPrompt';
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  arch: () => 'x64',
}));

let directory: string;
let api: Awaited<ReturnType<typeof startApiServer>>;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'mukai-vm-api-')));
  vi.stubEnv('MUKAI_QEMU_BINARY', process.execPath);
  vi.stubEnv('MUKAI_QEMU_IMAGE', join(directory, 'base.qcow2'));
  vi.stubEnv('MUKAI_QEMU_ACCEL', 'tcg');
  await writeFile(join(directory, 'base.qcow2'), 'fixture-only');
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function request<T = Record<string, unknown>>(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  return { status: response.status, data: (await response.json()) as T };
}
describe('workspace computer choice', () => {
  it('does not expose a VM viewer for local workspaces or unauthenticated callers', async () => {
    expect((await request('/workspaces/default/computer-view', 'POST')).status).toBe(400);
    const denied = await fetch(api.url + '/workspaces/default/computer-view', { method: 'POST' });
    expect(denied.status).toBe(401);
  });
  it('persists VM choice without treating guest paths as host folders, and keeps existing workspaces local', async () => {
    const created = await request<Workspace>('/workspaces', 'POST', {
      name: 'Guest project',
      computer: 'qemu',
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ computer: 'qemu', folder: null });
    expect((await request(`/workspaces/${created.data.id}/computer`)).data).toMatchObject({
      kind: 'qemu',
      state: 'stopped',
    });
    expect(
      (await request<Workspace[]>('/workspaces')).data.find(
        (workspace) => workspace.id === 'default',
      )?.computer,
    ).toBe('local');
    expect(
      (
        await request(`/workspaces/${created.data.id}`, 'PUT', {
          name: 'Change',
          folder: directory,
        })
      ).status,
    ).toBe(409);
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    api = await startApiServer(0, { dataDir: join(directory, 'data') });
    expect(
      (await request<Workspace[]>('/workspaces')).data.find(
        (workspace) => workspace.id === created.data.id,
      ),
    ).toMatchObject({ computer: 'qemu', folder: null });
  });
  it('exposes guest tools while rejecting host custom registration at the API boundary', async () => {
    const { data: workspace } = await request<Workspace>('/workspaces', 'POST', {
      name: 'VM',
      computer: 'qemu',
    });
    const { data: tools } = await request<ToolInfo[]>(`/tools?workspaceId=${workspace.id}`);
    for (const id of ['terminal', 'file_operations', 'image', 'browser'])
      expect(tools.find((tool) => tool.id === id)?.available).toBe(true);
    for (const id of ['register_custom_tool', 'register_custom_route'])
      expect(tools.find((tool) => tool.id === id)?.available).toBe(false);
    await expect(
      api.capabilities.manage(workspace.id, null, 'tool', {
        operation: 'register',
        modulePath: 'test.js',
        permissionMode: 'auto_approve',
      }),
    ).rejects.toThrow('unavailable in VM v1');
  });
  it('reports unavailable VM setup and preserves local folder validation', async () => {
    vi.stubEnv('MUKAI_QEMU_BINARY', join(directory, 'missing-qemu.exe'));
    expect((await request('/workspaces/computer-setup')).data.available).toBe(false);
    expect(
      (await request('/workspaces', 'POST', { name: 'No setup', computer: 'qemu' })).status,
    ).toBe(503);
    expect((await request('/workspaces', 'POST', { name: 'No folder' })).status).toBe(400);
    const folder = join(directory, 'local');
    await mkdir(folder);
    expect(
      (await request<Workspace>('/workspaces', 'POST', { name: 'Local', folder })).data,
    ).toMatchObject({ computer: 'local', folder });
    expect(
      (await request('/workspaces/default/computer', 'POST', { action: 'start' })).status,
    ).toBe(400);
  });
  it('gives the model guest terminal guidance', () => {
    const prompt = buildBotSystemPrompt({
      bot: { id: 'bot', name: 'Bot', role: 'Main', isMain: true, createdBy: null },
      instructions: '',
      pursuits: [],
      tools: { terminal: {} },
      previousOperations: false,
      computer: 'qemu',
      workspaceFolder: '/home/mukai/workspace',
    });
    expect(prompt).toContain('Terminal commands run inside the workspace Linux VM');
    expect(prompt).not.toContain('Terminal commands run locally with your OS account permissions');
  });
});
