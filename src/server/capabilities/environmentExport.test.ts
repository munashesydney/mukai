import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestWorkspace } from '../testFixtures';
import { parseDotEnv } from '../../shared/dotEnv';
let api: Awaited<ReturnType<typeof startApiServer>>, root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-env-export-'));
  api = await startApiServer(0, { dataDir: root });
  seedTestWorkspace(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  rmSync(root, { recursive: true, force: true });
});
it('exports only saved workspace variables on an explicit authenticated request and keeps ordinary discovery masked', async () => {
  const entries = [
    { name: 'TOKEN', value: 'dummy "quoted" \\n token\nnext line' },
    { name: 'EMPTY', value: '' },
  ];
  api.capabilities.environment.save('default', entries);
  const other = api.workspaces.create({ name: 'Other', folder: tmpdir() });
  api.capabilities.environment.save(other.id, [
    { name: 'OTHER_TOKEN', value: 'dummy-other-workspace' },
  ]);
  const auth = { Authorization: 'Bearer ' + api.token };
  const listing = await fetch(api.url + '/environment', { headers: auth });
  const listingText = await listing.text();
  expect(listingText).not.toContain('dummy');
  expect(JSON.parse(listingText)[0]).toHaveProperty('configured');
  const response = await fetch(api.url + '/environment/export?workspaceId=default', {
    method: 'POST',
    headers: auth,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(response.headers.get('content-disposition')).toContain('attachment;');
  expect(response.headers.get('content-type')).toContain('text/plain');
  const exported = await response.text();
  expect(parseDotEnv(exported)).toEqual([...entries].sort((a, b) => a.name.localeCompare(b.name)));
  expect(exported).not.toContain('OTHER_TOKEN');
  expect((await fetch(api.url + '/environment/export', { headers: auth })).status).toBe(404);
  expect((await fetch(api.url + '/environment/export', { method: 'POST' })).status).toBe(401);
  expect(
    (
      await fetch(api.url + '/environment/export', {
        method: 'POST',
        headers: { ...auth, Origin: 'https://untrusted.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(api.url + '/environment/export?workspaceId=missing', {
        method: 'POST',
        headers: auth,
      })
    ).status,
  ).toBe(404);
});
