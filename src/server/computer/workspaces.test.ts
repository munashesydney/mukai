import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from '../app';
import { seedTestWorkspace } from '../testFixtures';
import type { Workspace, ToolInfo } from '../../shared/ai';
import { buildBotSystemPrompt } from '../../shared/botSystemPrompt';
import { BotRepository } from '../repositories/botRepository';
import { ArtifactRepository } from '../repositories/artifactRepository';
import { scoutBot } from '../services/botService';
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
  seedTestWorkspace(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
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
  it('shows an unavailable-file message for stale VM artifacts and can read them again if restored', async () => {
    const { data: workspace } = await request<Workspace>('/workspaces', 'POST', {
      name: 'VM files',
      computer: 'qemu',
    });
    new BotRepository(api.store).create(scoutBot(workspace.id, 'vm-bot'));
    api.store
      .run(`INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at)
      VALUES('vm-message','vm-bot','bot-vm-bot','vm-request','assistant','Saved a file.','complete','now')`);
    new ArtifactRepository(api.store).save({
      id: 'vm-artifact',
      botId: 'vm-bot',
      messageId: 'vm-message',
      path: 'blender/_diag_bool.py',
      name: '_diag_bool.py',
      createdAt: 'now',
    });
    const download = vi
      .spyOn(api.computers.guest(workspace), 'request')
      .mockRejectedValue(new Error('The requested file or directory is unavailable.'));
    const missing = await request('/artifacts/vm-artifact');
    expect(missing.status).toBe(404);
    expect(missing.data.error).toContain('no longer available in the workspace VM');
    expect(missing.data.error).toContain('moved, deleted, or become inaccessible');
    expect(missing.data.error).not.toContain('server could not complete');
    download.mockResolvedValue({
      name: '_diag_bool.py',
      bytes: Buffer.from('print("restored")').toString('base64'),
    });
    const restored = await fetch(api.url + '/artifacts/vm-artifact', {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    expect(restored.status).toBe(200);
    expect(await restored.text()).toBe('print("restored")');
    download.mockRejectedValue(new Error('VM is unavailable.'));
    const offline = await request('/artifacts/vm-artifact');
    expect(offline.status).toBe(500);
    expect(offline.data.error).not.toContain('moved');
    download.mockRejectedValue(
      Object.assign(new Error('VM image is missing.'), { code: 'ENOENT' }),
    );
    expect((await request('/artifacts/vm-artifact')).status).toBe(500);
  });
  it('previews a previously viewed guest image through the VM and scopes it to its conversation', async () => {
    const { data: workspace } = await request<Workspace>('/workspaces', 'POST', {
      name: 'VM image',
      computer: 'qemu',
    });
    new BotRepository(api.store).create(scoutBot(workspace.id, 'image-bot'));
    api.store.run(
      `INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at,activity_json)
      VALUES('image-message','image-bot','bot-image-bot','image-request','assistant','','streaming','now',?)`,
      JSON.stringify([
        {
          id: 'view',
          tool: 'image',
          action: 'view',
          status: 'complete',
          path: '/home/mukai/workspace/render.png',
          summary: '{}',
        },
      ]),
    );
    const guest = vi
      .spyOn(api.computers.guest(workspace), 'request')
      .mockResolvedValue({ image: Buffer.from('fixture-image').toString('base64') });
    const path = '/conversations/bot-image-bot/activity-image';
    const input = { messageId: 'image-message', activityId: 'view' };
    const preview = await fetch(api.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(await preview.text()).toBe('fixture-image');
    expect(guest).toHaveBeenCalledWith(
      'image',
      { action: 'view', path: '/home/mukai/workspace/render.png' },
      { workspaceId: workspace.id, botId: 'image-bot', conversationId: 'bot-image-bot' },
      expect.any(AbortSignal),
    );
    expect((await request(path, 'POST', { ...input, activityId: 'other' })).status).toBe(404);
    guest.mockRejectedValue(
      new Error("ENOENT: no such file or directory, open '/home/mukai/workspace/render.png'"),
    );
    expect((await request(path, 'POST', input)).status).toBe(404);
    guest.mockRejectedValue(
      Object.assign(new Error('ENOENT: VM image is missing.'), { code: 'ENOENT' }),
    );
    expect((await request(path, 'POST', input)).status).toBe(500);
  });
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
  it('exposes guest tools and custom registration without using a host folder', async () => {
    const { data: workspace } = await request<Workspace>('/workspaces', 'POST', {
      name: 'VM',
      computer: 'qemu',
    });
    const { data: tools } = await request<ToolInfo[]>(`/tools?workspaceId=${workspace.id}`);
    for (const id of ['terminal', 'file_operations', 'media', 'browser'])
      expect(tools.find((tool) => tool.id === id)?.available).toBe(true);
    for (const id of ['register_custom_tool', 'register_custom_route'])
      expect(tools.find((tool) => tool.id === id)?.available).toBe(true);
    expect(
      await api.capabilities.manage(workspace.id, null, 'tool', { operation: 'list' }),
    ).toEqual([]);
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
      tools: { terminal: {} },
      computer: 'qemu',
      workspaceFolder: '/home/mukai/workspace',
    });
    expect(prompt).toContain('Terminal commands run inside the workspace Linux VM');
    expect(prompt).not.toContain('Terminal commands run locally with your OS account permissions');
  });
});
