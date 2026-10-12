import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from '../app';
import type { Workspace } from '../../shared/ai';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import { WorkspaceService } from '../services/workspaceService';
import { seedTestWorkspace } from '../testFixtures';

let api: Awaited<ReturnType<typeof startApiServer>>;
let directory: string;
let workspace: Workspace;
let workspaces: WorkspaceService;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mukai-resources-'));
  api = await startApiServer(0, {
    dataDir: directory,
    memoryExtractor: async () => ({ facts: [] }),
  });
  workspaces = new WorkspaceService(new WorkspaceRepository(api.store), directory, api.computers);
  seedTestWorkspace(api.store);
  workspace = workspaces.create({ name: 'VM', computer: 'qemu', folder: '' });
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  expect(directory.startsWith(join(tmpdir(), 'mukai-resources-'))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
async function save(input: unknown, id = workspace.id) {
  return fetch(`${api.url}/workspaces/${id}/computer-resources`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
it('defaults to 4 GB and 2 vCPUs, persists independent workspace resources, and configures cached computers', async () => {
  expect(workspaces.require(workspace.id).computerResources).toEqual({
    memoryMiB: 4096,
    vcpus: 2,
  });
  const computer = api.computers.guest(workspace);
  const second = workspaces.create({ name: 'Other VM', folder: '', computer: 'qemu' });
  expect((await save({ memoryMiB: 8192, vcpus: 4 })).status).toBe(200);
  const reloaded = new WorkspaceRepository(api.store).find(workspace.id)!;
  expect(reloaded.computerResources).toEqual({ memoryMiB: 8192, vcpus: 4 });
  expect(workspaces.require(second.id).computerResources).toEqual({
    memoryMiB: 4096,
    vcpus: 2,
  });
  expect(api.computers.guest(reloaded)).toBe(computer);
  expect(api.computers.status(reloaded)).toMatchObject({
    resources: { memoryMiB: 8192, vcpus: 4 },
    restartRequired: false,
  });
  expect(reloaded.folder).toBeNull();
  expect(reloaded.computer).toBe('qemu');
});
it('validates resource limits and rejects local workspaces without changing their settings', async () => {
  for (const input of [
    { memoryMiB: 0, vcpus: 2 },
    { memoryMiB: 4097, vcpus: 2 },
    { memoryMiB: 65537, vcpus: 2 },
    { memoryMiB: 4096, vcpus: 0 },
    { memoryMiB: 4096, vcpus: 33 },
    { memoryMiB: 4096, vcpus: 1.5 },
    { memoryMiB: 4096, vcpus: 2, computer: 'local' },
  ])
    expect((await save(input)).status).toBe(400);
  expect((await save({ memoryMiB: 4096, vcpus: 2 }, 'default')).status).toBe(400);
  expect((await save({ memoryMiB: 4096, vcpus: 2 }, 'missing')).status).toBe(404);
  expect(workspaces.require(workspace.id).computerResources).toEqual({
    memoryMiB: 4096,
    vcpus: 2,
  });
});
