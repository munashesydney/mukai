import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './app';
import { defaultUserProfile } from '../shared/userProfile';

let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
let directory: string | undefined;
async function close() {
  if (!api) return;
  await api.shutdown();
  await new Promise<void>((done) => api!.server.close(() => done()));
  api = undefined;
}
afterEach(async () => {
  await close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function request(path: string, method = 'GET', value?: unknown, authenticated = true) {
  return fetch(api!.url + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${api!.token}` } : {}),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
it('shares appearance, existing public base URL and limits when switching backends', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-settings-'));
  await mkdir(join(directory, 'project'));
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
  expect((await request('/settings/appearance', 'GET', undefined, false)).status).toBe(401);
  expect(await (await request('/settings/appearance')).json()).toEqual({ appearance: null });
  const appearance = { mode: 'dark', theme: 'ocean' };
  expect(await (await request('/settings/appearance', 'POST', appearance)).json()).toEqual({
    appearance,
  });
  expect(
    await (await request('/settings/appearance', 'POST', { mode: 'light', theme: 'mukai' })).json(),
  ).toEqual({ appearance });
  expect(
    (await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'unsupported' })).status,
  ).toBe(400);
  expect(
    (await request('/settings/appearance', 'PUT', { ...appearance, unknown: true })).status,
  ).toBe(400);
  expect(
    (await request('/capabilities/settings', 'PUT', { publicBaseUrl: 'https://mukai.example' }))
      .status,
  ).toBe(200);
  expect((await request('/limits', 'PUT', { pursuitConcurrency: 9 })).status).toBe(200);
  const workspace = (await (
    await request('/workspaces', 'POST', {
      name: 'Shared workspace',
      folder: join(directory, 'project'),
    })
  ).json()) as { id: string };
  expect(workspace.id).toBeTruthy();
  expect(api.store.get('SELECT value FROM app_settings WHERE key=?', 'appearance')?.value).toBe(
    JSON.stringify(appearance),
  );
  const previousUrl = api.url;
  await close();
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
  expect(api.url).not.toBe(previousUrl);
  expect(await (await request('/settings/appearance')).json()).toEqual({ appearance });
  expect(await (await request('/limits')).json()).toEqual({ pursuitConcurrency: 9 });
  expect(await (await request('/capabilities/settings')).json()).toMatchObject({
    publicBaseUrl: 'https://mukai.example',
    localBaseUrl: api.url,
  });
  expect(await (await request('/workspaces')).json()).toContainEqual(
    expect.objectContaining({ id: workspace.id }),
  );
});

it('validates and persists the user profile across backend restarts without changing appearance', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-profile-'));
  api = await startApiServer(0, { dataDir: directory });
  expect((await request('/settings/profile', 'GET', undefined, false)).status).toBe(401);
  expect(await (await request('/settings/profile')).json()).toEqual(defaultUserProfile);
  for (const patch of [
    { background: 'url(https://example.com/image)' },
    { icon: 'unknown' },
    { letter: '<>' },
    { mode: 'image' },
    { extra: true },
  ])
    expect(
      (await request('/settings/profile', 'PUT', { ...defaultUserProfile, ...patch })).status,
    ).toBe(400);
  const profile = { mode: 'letter', letter: 'SY', icon: 'rocket', background: '#438571' };
  expect(await (await request('/settings/profile', 'PUT', profile)).json()).toEqual(profile);
  await close();
  api = await startApiServer(0, { dataDir: directory });
  expect(await (await request('/settings/profile')).json()).toEqual(profile);
  expect(await (await request('/settings/appearance')).json()).toEqual({ appearance: null });
});
