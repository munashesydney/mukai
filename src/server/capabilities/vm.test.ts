import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { GuestDispatcher } from '../computer/guestDispatcher';
import type { QemuComputer } from '../computer/qemuComputer';
import type { CapabilityRegistration } from '../../shared/customCapabilities';
import { scoutBot } from '../services/botService';

let api: Awaited<ReturnType<typeof startApiServer>>;
let guest: GuestDispatcher;
let root: string, folder: string;
function attachGuest() {
  return vi.spyOn(api.computers, 'guest').mockReturnValue(guest as unknown as QemuComputer);
}
async function register(kind: 'tool' | 'route', source: string, modulePath = 'module.ts') {
  await writeFile(join(folder, modulePath), source);
  return (await api.capabilities.manage('default', 'scout', kind, {
    operation: 'register',
    modulePath,
    ...(kind === 'tool' ? { permissionMode: 'auto_approve' as const } : {}),
  })) as CapabilityRegistration;
}
function toolSource(body: string, extra = '') {
  return `export default {name:'guest_tool',description:'Test guest execution',
    inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},
    ${extra}execute(args,context){${body}}};`;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mukai-guest-capabilities-')));
  folder = join(root, 'workspace');
  await mkdir(folder);
  guest = new GuestDispatcher(folder, join(root, 'guest-data'));
  api = await startApiServer(0, { dataDir: join(root, 'host-data') });
  seedTestBot(api.store);
  api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
  attachGuest();
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await guest.shutdown();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('VM capability registration and execution', () => {
  it('compiles guest dependencies and exposes registered tools with assignments', async () => {
    await writeFile(join(folder, 'math.ts'), 'export const multiply = (a:number,b:number) => a*b;');
    const item = await register(
      'tool',
      `import {multiply} from './math';\n${toolSource('return {product:multiply(args.value,3),file:__filename};')}`,
    );
    expect(item.status).toBe('ready');
    const result = (await api.capabilities.invoke(item.id, { value: 7 })) as {
      product: number;
      file: string;
    };
    expect(result.product).toBe(21);
    expect(result.file.startsWith(join(root, 'guest-data', 'capability-staging'))).toBe(true);
    const tools = api.capabilities.forBot(scoutBot(), new AbortController().signal, () => {});
    expect(tools).toHaveProperty('register_custom_tool');
    expect(tools).toHaveProperty('register_custom_route');
    expect(tools).toHaveProperty('guest_tool');
    api.access.set('default', 'scout', 'custom:' + item.id, false);
    expect(api.access.allowed(scoutBot(), 'custom:' + item.id)).toBe(false);
    await expect(api.capabilities.invoke(item.id, { value: 'invalid' })).rejects.toThrow(
      'inputSchema',
    );
  });
  it('pins saved code across edits, failed updates, disable/enable and controller restart', async () => {
    const marker = join(folder, 'imports.txt');
    const source = `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'import\\n');\n${toolSource('return args.value*2;')}`;
    const item = await register('tool', source, 'module.js');
    await writeFile(join(folder, 'module.js'), toolSource('return 999;'));
    expect(await api.capabilities.invoke(item.id, { value: 4 })).toBe(8);
    await writeFile(join(folder, 'module.js'), 'export default {');
    await expect(
      api.capabilities.manage('default', 'scout', 'tool', { operation: 'update', id: item.id }),
    ).rejects.toThrow();
    expect(api.capabilities.list('default')[0].version).toBe(item.version);
    await api.capabilities.manage('default', 'scout', 'tool', {
      operation: 'disable',
      id: item.id,
    });
    await expect(api.capabilities.invoke(item.id, { value: 4 })).rejects.toThrow('disabled');
    await api.capabilities.manage('default', 'scout', 'tool', { operation: 'enable', id: item.id });
    const before = await readFile(marker, 'utf8');
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    api = await startApiServer(0, { dataDir: join(root, 'host-data') });
    attachGuest();
    expect(await readFile(marker, 'utf8')).toBe(before);
    expect(api.capabilities.list('default')[0].status).toBe('ready');
    expect(await api.capabilities.invoke(item.id, { value: 5 })).toBe(10);
    await writeFile(join(folder, 'module.js'), toolSource('return args.value*3;'));
    const updated = (await api.capabilities.manage('default', 'scout', 'tool', {
      operation: 'update',
      id: item.id,
    })) as CapabilityRegistration;
    expect(updated.version).not.toBe(item.version);
    expect(await api.capabilities.invoke(item.id, { value: 5 })).toBe(15);
  });
  it('forwards exact webhook bytes and persists deduplicated jobs before acknowledgment', async () => {
    const completed = join(folder, 'jobs.txt');
    const item = await register(
      'route',
      `import {appendFileSync} from 'node:fs';
      export default {name:'guest_webhook',method:'POST',path:'/custom/guest-webhook',auth:'mukai',
      async handle(request,context){const job=await context.enqueue('fixture',request.headers['event-id'],{raw:request.rawBody.toString('hex')});return {status:202,body:job};},
      processJob(payload){appendFileSync(${JSON.stringify(completed)},payload.raw+'\\n');return {done:true};}};`,
    );
    const raw = '{ "value": "🌱" }\r\n';
    const call = (authorized: boolean) =>
      fetch(api.url + '/custom/guest-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Event-Id': 'event-1',
          ...(authorized ? { Authorization: 'Bearer ' + api.token } : {}),
        },
        body: raw,
      });
    expect((await call(false)).status).toBe(401);
    const first = await call(true);
    expect(first.status).toBe(202);
    const saved = await first.json();
    expect(api.store.get('SELECT id FROM capability_jobs WHERE capability_id=?', item.id)?.id).toBe(
      saved.id,
    );
    const second = await call(true);
    expect(await second.json()).toEqual({ id: saved.id, duplicate: true });
    await vi.waitFor(
      () => expect(api.capabilities.detail(item.id, 'default').jobs[0].status).toBe('complete'),
      { timeout: 5000 },
    );
    expect(await readFile(completed, 'utf8')).toBe(Buffer.from(raw).toString('hex') + '\n');
  });
  it('commits guest wakeBot calls in the controller and validates the target', async () => {
    api.capabilities.setWake(vi.fn(async () => {}));
    const item = await register(
      'tool',
      toolSource("return context.wakeBot('guest message',{botId:'scout'});"),
    );
    expect(await api.capabilities.invoke(item.id, { value: 1 })).toEqual({ accepted: true });
    expect(
      api.store.get('SELECT provider FROM capability_jobs WHERE capability_id=?', item.id)
        ?.provider,
    ).toBe('__mukai_wake');
    await writeFile(
      join(folder, 'module.ts'),
      toolSource("return context.wakeBot('guest message',{botId:'missing'});"),
    );
    await api.capabilities.manage('default', 'scout', 'tool', { operation: 'update', id: item.id });
    await expect(api.capabilities.invoke(item.id, { value: 1 })).rejects.toThrow();
  });
  it('enforces deadlines and cancellation, cleans staging and propagates guest failure without fallback', async () => {
    const item = await register('tool', toolSource('while(true){}', 'timeoutMs:100,'));
    await expect(api.capabilities.invoke(item.id, { value: 1 })).rejects.toThrow('timed out');
    await writeFile(join(folder, 'module.ts'), toolSource('return new Promise(()=>{});'));
    await api.capabilities.manage('default', 'scout', 'tool', { operation: 'update', id: item.id });
    const controller = new AbortController();
    const running = api.capabilities.invoke(item.id, { value: 1 }, 'execute', controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toThrow('cancelled');
    expect(
      api.capabilities.detail(item.id, 'default').runs.some((run) => run.status === 'interrupted'),
    ).toBe(true);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(root, 'guest-data', 'capability-staging'))).toEqual([]);
    vi.spyOn(guest, 'request').mockRejectedValueOnce(new Error('Guest disconnected'));
    await expect(api.capabilities.invoke(item.id, { value: 1 })).rejects.toThrow(
      'Guest disconnected',
    );
  });
  it('rejects host paths and redacts declared guest secrets from results and errors', async () => {
    await expect(
      api.capabilities.manage('default', 'scout', 'tool', {
        operation: 'register',
        modulePath: join(folder, 'module.ts'),
        permissionMode: 'auto_approve',
      }),
    ).rejects.toThrow('relative path');
    const item = await register(
      'tool',
      toolSource(
        'return {secret:context.env.GUEST_SECRET,ambient:process.env.GUEST_SECRET};',
        "requiredEnv:['GUEST_SECRET'],",
      ),
    );
    expect(item.status).toBe('needs_configuration');
    api.capabilities.environment.save('default', [
      { name: 'GUEST_SECRET', value: 'guest-secret-fixture' },
    ]);
    const result = await api.capabilities.invoke(item.id, { value: 1 });
    expect(JSON.stringify(result)).not.toContain('guest-secret-fixture');
    await writeFile(
      join(folder, 'module.ts'),
      toolSource('throw new Error(context.env.GUEST_SECRET);', "requiredEnv:['GUEST_SECRET'],"),
    );
    await api.capabilities.manage('default', 'scout', 'tool', { operation: 'update', id: item.id });
    await expect(api.capabilities.invoke(item.id, { value: 1 })).rejects.not.toThrow(
      'guest-secret-fixture',
    );
  });
});
