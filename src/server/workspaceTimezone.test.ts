import { expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from './app';
import { migrations } from './db/migrations';
import { Database } from './db/database';

it('persists independent zones, initializes legacy workspaces once, and preserves scheduled instants', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mukai-timezone-')));
  const dataDir = join(root, 'data');
  const folder = join(root, 'project');
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
    await new Promise<void>((done) => api.server.close(() => done()));
    api.dispose();
  };
  try {
    expect(
      (await request('/workspaces', 'POST', { name: 'Invalid', folder, timeZone: 'PST' })).status,
    ).toBe(400);
    const created = await request('/workspaces', 'POST', {
      name: 'Local',
      folder,
      timeZone: 'America/Vancouver',
    });
    expect(created.status).toBe(201);
    const id = created.data.id;
    const timestamp = created.data.createdAt;
    const path = '/workspaces/' + id + '/timezone';
    expect((await request(path, 'PUT', { timeZone: '+05:00' })).status).toBe(400);
    expect((await request(path, 'PUT', { timeZone: 'Asia/Kathmandu', folder })).status).toBe(400);
    expect((await request(path, 'POST', { timeZone: 'UTC' })).data.timeZone).toBe(
      'America/Vancouver',
    );
    const bot = (
      await request('/bots', 'POST', {
        workspaceId: id,
        name: 'Clock',
        role: 'Assistant',
        instructions: 'Help.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'scout',
      })
    ).data;
    const pursuit = api.pursuits.create(bot, {
      name: 'Scheduled',
      objective: 'Check later',
      successCriteria: 'Checked',
      firstRunAt: '2099-01-16T17:00:00Z',
      deadline: '2099-01-17T17:00:00Z',
    });
    const changed = await request(path, 'PUT', { timeZone: 'Asia/Kathmandu' });
    expect(changed.data).toMatchObject({
      id,
      folder,
      timeZone: 'Asia/Kathmandu',
      createdAt: timestamp,
    });
    expect(api.pursuits.require(pursuit.id)).toMatchObject({
      nextRunAt: pursuit.nextRunAt,
      deadline: pursuit.deadline,
    });
    // Simulate a database created before the new column was introduced.
    await stop();
    let database = new Database(dataDir);
    database.db.exec('ALTER TABLE workspaces DROP COLUMN time_zone');
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes('ALTER TABLE workspaces ADD COLUMN time_zone')) +
        1,
    );
    database.db.close();
    api = await startApiServer(0, { dataDir });
    expect((await request('/workspaces')).data[0].timeZone).toBeUndefined();
    expect((await request(path, 'POST', { timeZone: 'America/Vancouver' })).data.timeZone).toBe(
      'America/Vancouver',
    );
    expect((await request(path, 'POST', { timeZone: 'Asia/Tokyo' })).data.timeZone).toBe(
      'America/Vancouver',
    );
    await stop();
    api = await startApiServer(0, { dataDir });
    expect((await request('/workspaces')).data[0]).toMatchObject({
      timeZone: 'America/Vancouver',
      createdAt: timestamp,
    });
    expect(api.pursuits.require(pursuit.id).nextRunAt).toBe(pursuit.nextRunAt);
    const otherFolder = join(root, 'other');
    await mkdir(otherFolder);
    const other = (
      await request('/workspaces', 'POST', {
        name: 'UTC workspace',
        folder: otherFolder,
        timeZone: 'UTC',
      })
    ).data;
    await request(path, 'PUT', { timeZone: 'Asia/Kathmandu' });
    expect(
      (await request('/workspaces')).data.find((w: { id: string }) => w.id === other.id).timeZone,
    ).toBe('UTC');
    expect(api.workspaces.timeZone(id)).toBe('Asia/Kathmandu');
    database = api.store;
    expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
