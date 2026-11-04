import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestWorkspace } from '../testFixtures';

let api: Awaited<ReturnType<typeof startApiServer>>, root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-env-rename-'));
  api = await startApiServer(0, { dataDir: root });
  seedTestWorkspace(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  rmSync(root, { recursive: true, force: true });
});
async function save(entries: unknown[], workspaceId = 'default') {
  return fetch(api.url + '/environment?workspaceId=' + workspaceId, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
}

it('renames the saved variable while preserving its encrypted value and workspace scope', async () => {
  const other = api.workspaces.create({ name: 'Other', folder: tmpdir() });
  expect((await save([{ name: 'OLD_KEY', value: 'private-original-value' }])).status).toBe(200);
  await save([{ name: 'OLD_KEY', value: 'other-workspace-value' }], other.id);

  const response = await save([{ originalName: 'OLD_KEY', name: 'NEW_KEY' }]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { name: 'NEW_KEY', configured: true, secret: true, usedBy: [] },
  ]);
  expect(api.capabilities.environment.resolve('default', ['OLD_KEY', 'NEW_KEY'])).toEqual({
    NEW_KEY: 'private-original-value',
  });
  expect(api.capabilities.environment.resolve(other.id, ['OLD_KEY', 'NEW_KEY'])).toEqual({
    OLD_KEY: 'other-workspace-value',
  });
  expect(JSON.stringify(api.store.all('SELECT value FROM capability_env'))).not.toContain(
    'private-original-value',
  );
  expect(api.capabilities.environment.redact('private-original-value')).toBe('[redacted]');
});

it('supports value and sensitivity edits during a rename and keeps rotated secrets redacted', async () => {
  await save([{ name: 'OLD_KEY', value: 'private-original-value' }]);
  const response = await save([
    { originalName: 'OLD_KEY', name: 'NEW_KEY', value: 'new-config-value', secret: false },
  ]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { name: 'NEW_KEY', configured: true, secret: false, usedBy: [] },
  ]);
  expect(api.capabilities.environment.resolve('default', ['OLD_KEY', 'NEW_KEY'])).toEqual({
    NEW_KEY: 'new-config-value',
  });
  expect(api.capabilities.environment.redact('private-original-value')).toBe('[redacted]');
  expect(api.capabilities.environment.redact('new-config-value')).toBe('new-config-value');

  expect((await save([{ originalName: 'NEW_KEY', name: 'NEW_KEY' }])).status).toBe(200);
  expect(api.capabilities.environment.resolve('default', ['NEW_KEY'])).toEqual({
    NEW_KEY: 'new-config-value',
  });
});

it('rejects a conflicting rename without changing either variable or committing partial saves', async () => {
  await save([
    { name: 'OLD_KEY', value: 'original-value' },
    { name: 'EXISTING_KEY', value: 'existing-value' },
  ]);
  const response = await save([
    { name: 'PARTIAL_KEY', value: 'must-rollback' },
    { originalName: 'OLD_KEY', name: 'EXISTING_KEY', value: 'replacement-value' },
  ]);
  expect(response.status).toBe(409);
  expect(
    api.capabilities.environment.resolve('default', ['OLD_KEY', 'EXISTING_KEY', 'PARTIAL_KEY']),
  ).toEqual({ OLD_KEY: 'original-value', EXISTING_KEY: 'existing-value' });
});

it('validates names and new values while retaining add/import upserts', async () => {
  expect((await save([{ name: 'NEW_KEY' }])).status).toBe(400);
  expect((await save([{ originalName: 'INVALID-NAME', name: 'NEW_KEY' }])).status).toBe(400);
  expect((await save([{ originalName: 'NEW_KEY', name: 'INVALID-NAME' }])).status).toBe(400);
  expect((await save([{ name: 'NEW_KEY', value: 'first-value', secret: false }])).status).toBe(200);
  expect((await save([{ name: 'NEW_KEY', value: 'imported-value' }])).status).toBe(200);
  expect(api.capabilities.environment.resolve('default', ['NEW_KEY'])).toEqual({
    NEW_KEY: 'imported-value',
  });
  expect(api.capabilities.environment.list('default')[0].secret).toBe(false);
});
