import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from './app';
import { BotRepository } from './repositories/botRepository';
import { WorkspaceRepository } from './repositories/workspaceRepository';
import { scoutBot } from './services/botService';
import { workspaceBrowserProfile } from './browser/profile';
import type { Workspace } from '../shared/ai';

let directory: string;
let api: Awaited<ReturnType<typeof startApiServer>>;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'mukai-delete-')));
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await rm(directory, { recursive: true, force: true });
});
async function request(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { status: response.status, data: await response.json() };
}
function vm(name = 'Disposable') {
  return api.workspaces.create({ name, computer: 'qemu', folder: '' });
}
async function file(path: string, value = 'keep') {
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
function bot(workspace: Workspace, id = 'test-bot') {
  const value = scoutBot(workspace.id, id);
  new BotRepository(api.store).create(value);
  return value;
}

it('requires authentication and the exact workspace name before deleting anything', async () => {
  const workspace = vm();
  expect((await fetch(api.url + '/workspaces/' + workspace.id, { method: 'DELETE' })).status).toBe(
    401,
  );
  expect((await request('/workspaces/' + workspace.id, 'DELETE', { name: 'wrong' })).status).toBe(
    400,
  );
  expect(api.workspaces.require(workspace.id).deleting).toBeUndefined();
  expect((await request('/workspaces/missing', 'DELETE', { name: 'missing' })).status).toBe(404);
});

it('removes VM storage and its bot tree, chats, uploads, memories, and pursuits while preserving another workspace', async () => {
  const workspace = vm();
  const other = vm('Keep');
  bot(workspace);
  new BotRepository(api.store).create({
    ...scoutBot(workspace.id, 'child'),
    isMain: false,
    createdBy: 'test-bot',
  });
  bot(other, 'keep-bot');
  const disk = join(api.store.dir, 'computers', workspace.id, 'disk.qcow2');
  const otherDisk = join(api.store.dir, 'computers', other.id, 'disk.qcow2');
  const base = join(api.store.dir, 'computer-setup', 'mukai-linux.qcow2');
  await file(disk);
  await file(otherDisk);
  await file(base);
  const profile = join(
    api.store.dir,
    'browser-profiles',
    'chrome',
    'workspaces',
    workspaceBrowserProfile(workspace.id),
    'History',
  );
  await file(profile);
  api.store.run('INSERT INTO metadata VALUES(?,?)', 'approval-mode:' + workspace.id, 'full-access');
  api.store.run('INSERT INTO metadata VALUES(?,?)', 'space_import:' + workspace.id, '1');
  const upload = join(api.store.dir, 'uploads', 'owned.txt');
  await file(upload);
  api.store.run(
    `INSERT INTO attachments(id,bot_id,name,media_type,size,kind,storage_name,conversation_id) VALUES('attachment','test-bot','owned','text/plain',4,'text','owned.txt','bot-test-bot')`,
  );
  api.store.run(
    `INSERT INTO messages(id,bot_id,request_id,role,status,created_at,conversation_id) VALUES('message','test-bot','request','user','complete','now','bot-test-bot')`,
  );
  api.store.run(
    `INSERT INTO pursuits(id,workspace_id,name,objective,success_criteria,owner_bot_id,status,interval_minutes,next_run_reason,created_at) VALUES('pursuit',?,'P','O','S','test-bot','paused',1,'','now')`,
    workspace.id,
  );
  api.store.run(
    `INSERT INTO pursuit_runs(id,pursuit_id,conversation_id,status,trigger,started_at,snapshot_json) VALUES('run','pursuit','bot-test-bot','complete','manual','now','{}')`,
  );
  api.memory.import(workspace.id, [
    {
      subject: 'Person',
      relation: 'likes',
      object: 'Tea',
      text: 'Person likes tea',
      validFrom: new Date().toISOString(),
      validTo: null,
      state: 'confirmed',
    },
  ]);
  expect(
    (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
  ).toBe(200);
  for (const path of [disk, profile, upload])
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(otherDisk, 'utf8')).toBe('keep');
  expect(await readFile(base, 'utf8')).toBe('keep');
  expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  for (const table of [
    'bots',
    'conversations',
    'memory_facts',
    'memory_entities',
    'memory_settings',
  ])
    expect(api.store.all(`SELECT * FROM ${table} WHERE workspace_id=?`, workspace.id)).toEqual([]);
  expect(api.store.all('SELECT * FROM pursuit_runs')).toEqual([]);
  expect(
    api.store.get('SELECT * FROM metadata WHERE key=?', 'approval-mode:' + workspace.id),
  ).toBeUndefined();
  expect(
    api.store.get('SELECT * FROM metadata WHERE key=?', 'space_import:' + workspace.id),
  ).toBeUndefined();
  expect(api.workspaces.require(other.id).name).toBe('Keep');
  expect(
    (await request('/workspaces/' + workspace.id + '/computer', 'POST', { action: 'start' }))
      .status,
  ).toBe(404);
});

it('preserves connected project files and allows deleting the final workspace without recreating it on restart', async () => {
  const project = join(directory, 'project');
  await file(join(project, '.mukai', 'artifacts', 'saved.txt'), 'project');
  await file(join(project, 'source.ts'), 'source');
  const workspace = api.workspaces.create({ name: 'Local', folder: project });
  await api.workspaces.remove(workspace.id, workspace.name);
  expect(await readFile(join(project, 'source.ts'), 'utf8')).toBe('source');
  expect(await readFile(join(project, '.mukai', 'artifacts', 'saved.txt'), 'utf8')).toBe('project');
  const initial = api.workspaces.require('default');
  await api.workspaces.remove(initial.id, initial.name);
  expect(api.workspaces.list()).toEqual([]);
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
  expect(api.workspaces.list()).toEqual([]);
});

it('blocks new work and keeps the disk when shutdown fails, then retries successfully', async () => {
  const workspace = vm();
  bot(workspace);
  const disk = join(api.store.dir, 'computers', workspace.id, 'disk.qcow2');
  await file(disk);
  const stopping = vi
    .spyOn(api.computers, 'remove')
    .mockRejectedValueOnce(new Error('Cannot stop fixture'));
  expect(
    (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
  ).toBe(500);
  expect(await readFile(disk, 'utf8')).toBe('keep');
  expect(api.workspaces.list().find((value) => value.id === workspace.id)?.deleting).toBe(true);
  expect((await request('/bots?workspaceId=' + workspace.id)).status).toBe(409);
  expect(
    (await request('/workspaces/' + workspace.id + '/computer', 'POST', { action: 'start' }))
      .status,
  ).toBe(409);
  stopping.mockRestore();
  expect(
    (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
  ).toBe(200);
});

it('resumes interrupted file cleanup at startup', async () => {
  const workspace = vm();
  const disk = join(api.store.dir, 'computers', workspace.id, 'disk.qcow2');
  await file(disk);
  new WorkspaceRepository(api.store).beginDeletion(workspace.id, [join('computers', workspace.id)]);
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  api = await startApiServer(0, { dataDir: join(directory, 'data') });
  expect(api.workspaces.list().some((value) => value.id === workspace.id)).toBe(false);
  await expect(readFile(disk)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses to delete a disk owned by an orphaned live process', async () => {
  const workspace = vm();
  const disk = join(api.store.dir, 'computers', workspace.id, 'disk.qcow2');
  await file(disk);
  await file(join(api.store.dir, 'computers', workspace.id, 'runtime.pid'), String(process.pid));
  expect(
    (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
  ).toBe(409);
  expect(await readFile(disk, 'utf8')).toBe('keep');
});

it('refuses cleanup through an ancestor junction outside private storage', async () => {
  const workspace = vm();
  const outside = join(directory, 'outside');
  await file(join(outside, workspace.id, 'disk.qcow2'), 'preserve');
  await symlink(
    outside,
    join(api.store.dir, 'computers'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(
    (await request('/workspaces/' + workspace.id, 'DELETE', { name: workspace.name })).status,
  ).toBe(500);
  expect(await readFile(join(outside, workspace.id, 'disk.qcow2'), 'utf8')).toBe('preserve');
});

it('joins duplicate delete requests instead of stopping the VM twice', async () => {
  const workspace = vm();
  let release!: () => void;
  const stop = vi.spyOn(api.computers, 'remove').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = api.workspaces.remove(workspace.id, workspace.name);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  const second = api.workspaces.remove(workspace.id, workspace.name);
  expect(second).toBe(first);
  release();
  await Promise.all([first, second]);
});

it('aborts an executing custom capability before removing its records and private module', async () => {
  const project = join(directory, 'project');
  await file(
    join(project, 'slow.ts'),
    `export default { name: 'slow', description: 'Test', inputSchema: {type:'object'}, requiredEnv: [], timeoutMs: 30000, async execute() { await new Promise(resolve => setTimeout(resolve, 20000)); return 'done'; } };`,
  );
  const workspace = api.workspaces.create({ name: 'Local', folder: project });
  const registration = await api.capabilities.manage(workspace.id, null, 'tool', {
    operation: 'register',
    modulePath: 'slow.ts',
    permissionMode: 'auto_approve',
  });
  if (!('id' in registration)) throw new Error('Expected registration');
  const task = api.capabilities.invoke(registration.id, {});
  const rejection = expect(task).rejects.toThrow('cancelled');
  await api.workspaces.remove(workspace.id, workspace.name);
  await rejection;
  expect(api.store.all('SELECT * FROM capability_runs')).toEqual([]);
  await expect(
    readFile(join(api.store.dir, 'capabilities', registration.version, 'module.cjs')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not accept another workspace or shared image path from a damaged cleanup checkpoint', async () => {
  const workspace = vm();
  const base = join(api.store.dir, 'computer-setup', 'mukai-linux.qcow2');
  await file(base);
  new WorkspaceRepository(api.store).beginDeletion(workspace.id, [
    join('computer-setup', 'mukai-linux.qcow2'),
  ]);
  await expect(api.workspaces.remove(workspace.id)).rejects.toThrow(
    'Invalid workspace cleanup path',
  );
  expect(await readFile(base, 'utf8')).toBe('keep');
});

it('removes obsolete compiled capability versions as well as the current version', async () => {
  const project = join(directory, 'project');
  const source = join(project, 'module.ts');
  await file(
    source,
    `export default {name:'test_module',description:'Test module',inputSchema:{type:'object'},requiredEnv:[],execute(){return 'first';}};`,
  );
  const workspace = api.workspaces.create({ name: 'Modules', folder: project });
  const first = await api.capabilities.manage(workspace.id, null, 'tool', {
    operation: 'register',
    modulePath: 'module.ts',
    permissionMode: 'auto_approve',
  });
  if (!('id' in first)) throw new Error('Expected registration');
  await writeFile(
    source,
    `export default {name:'test_module',description:'Test module',inputSchema:{type:'object'},requiredEnv:[],execute(){return 'second';}};`,
  );
  await api.capabilities.manage(workspace.id, null, 'tool', {
    operation: 'update',
    id: first.id,
    modulePath: 'module.ts',
  });
  await api.workspaces.remove(workspace.id, workspace.name);
  await expect(
    readFile(join(api.store.dir, 'capabilities', first.version, 'module.cjs')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(api.store.all('SELECT * FROM workspace_capability_versions')).toEqual([]);
});
