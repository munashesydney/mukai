import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import type { CapabilityRegistration } from '../../shared/customCapabilities';

let api: Awaited<ReturnType<typeof startApiServer>>, root: string, folder: string;
const signal = () => new AbortController().signal;
async function register(source: string, kind: 'job' | 'route' = 'job', file = 'job.ts') {
  writeFileSync(join(folder, file), source);
  return (await api.capabilities.manage('default', 'scout', kind, {
    operation: 'register',
    modulePath: file,
  })) as CapabilityRegistration;
}
function source(triggers = "[{type:'interval',intervalMs:1000}]", body = 'return event;') {
  return `export default {name:'test_job',description:'A test job',triggers:${triggers},async run(event,context){${body}}};`;
}
async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 25 });
}
async function close() {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-custom-jobs-'));
  folder = join(root, 'workspace');
  mkdirSync(folder);
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  seedTestBot(api.store);
  api.workspaces.update('default', { name: 'Test', folder });
});
afterEach(async () => {
  await close();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('validates job contracts and preserves working code and due times on a failed update', async () => {
  const item = await register(source());
  expect(item.kind).toBe('job');
  expect(item.nextRunAt).toBeTruthy();
  for (const triggers of [
    '[]',
    "[{type:'interval',intervalMs:0}]",
    "[{type:'workspace_start'},{type:'workspace_start'}]",
    "[{type:'cron',expression:'* * * * *'}]",
  ]) {
    writeFileSync(join(folder, 'job.ts'), source(triggers));
    await expect(
      api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: item.id }),
    ).rejects.toThrow();
    expect(api.capabilities.detail(item.id, 'default').registration).toMatchObject({
      version: item.version,
      nextRunAt: item.nextRunAt,
    });
  }
  expect(
    api.capabilities.forBot({ id: 'scout', workspaceId: 'default' } as never, signal(), () => {}),
  ).toHaveProperty('register_custom_job');
});
it('injects environment, workspace identity, cancellation, route calls and durable bot wake-ups', async () => {
  api.capabilities.environment.save('default', [{ name: 'JOB_SECRET', value: 'hidden-job-value' }]);
  const wake = vi.fn(async () => {});
  api.capabilities.setWake(wake);
  const route = await register(
    "export default {name:'job_target',method:'GET',path:'/custom/job-target',auth:'mukai',handle(){return {status:200,body:'route-ok'}}}",
    'route',
    'route.ts',
  );
  const item =
    await register(`export default {name:'context_job',description:'Check shared helpers',triggers:[{type:'workspace_start'}],requiredEnv:['JOB_SECRET'],async run(event,context){
    if(context.env.JOB_SECRET!=='hidden-job-value') throw new Error('Missing environment');
    const route=await context.callRoute(${JSON.stringify(route.id)});
    await context.wakeBot('Job found actionable work');
    return {workspace:context.workspaceId,trigger:event.trigger,aborted:context.signal.aborted,route:route.body,secret:context.env.JOB_SECRET};
  }}`);
  const result = await api.capabilities.manage('default', 'scout', 'job', {
    operation: 'run_now',
    id: item.id,
  });
  expect(result).toMatchObject({
    result: { workspace: 'default', trigger: 'manual', aborted: false, route: 'route-ok' },
  });
  expect(JSON.stringify(result)).not.toContain('hidden-job-value');
  await waitFor(() => wake.mock.calls.length === 1);
  expect(wake).toHaveBeenCalledWith(
    'scout',
    'default',
    'Job found actionable work',
    expect.any(String),
  );
});
it('coalesces overdue intervals, serializes manual and scheduled runs, and records failures', async () => {
  const item = await register(
    source(undefined, 'await new Promise(r=>setTimeout(r,150)); return event;'),
  );
  const running = api.capabilities.manage('default', 'scout', 'job', {
    operation: 'run_now',
    id: item.id,
  });
  await expect(
    api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: item.id }),
  ).rejects.toThrow('already running');
  api.store.run(
    'UPDATE capability_schedules SET next_at=? WHERE capability_id=?',
    Date.now() - 100000,
    item.id,
  );
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(api.capabilities.detail(item.id, 'default').runs).toHaveLength(1);
  await running;
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  await waitFor(
    () =>
      api.capabilities.detail(item.id, 'default').runs.filter((r) => r.status === 'complete')
        .length === 2,
  );
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(api.capabilities.detail(item.id, 'default').runs).toHaveLength(2);
  writeFileSync(join(folder, 'job.ts'), source(undefined, "throw new Error('Expected failure');"));
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: item.id });
  await expect(
    api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: item.id }),
  ).rejects.toThrow('Expected failure');
  expect(api.capabilities.detail(item.id, 'default').runs[0]).toMatchObject({
    status: 'failed',
    error: 'Expected failure',
  });
});
it('runs startup jobs once per backend runtime, persists intervals, and does not run at registration', async () => {
  const marker = join(folder, 'starts.txt');
  const item = await register(
    `import {appendFileSync} from 'node:fs'; ${source("[{type:'workspace_start'},{type:'interval',intervalMs:60000}]", `appendFileSync(${JSON.stringify(marker)},event.trigger+'\\n'); return event;`)}`,
  );
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(existsSync(marker)).toBe(false);
  const next = item.nextRunAt;
  await close();
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  expect(api.capabilities.list('default')[0].nextRunAt).toBe(next);
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  await waitFor(() => existsSync(marker));
  await waitFor(() => api.capabilities.detail(item.id, 'default').runs[0]?.status === 'complete');
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(readFileSync(marker, 'utf8')).toBe('workspace_start\n');
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'disable', id: item.id });
  api.store.run('UPDATE capability_schedules SET next_at=0 WHERE capability_id=?', item.id);
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(api.capabilities.detail(item.id, 'default').runs).toHaveLength(1);
});
it('defers VM jobs until ready and runs once for each boot identity without starting the computer', async () => {
  const item = await register(source("[{type:'workspace_start'}]"));
  api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
  let runtime: string | undefined;
  vi.spyOn(api.computers, 'runtimeId').mockImplementation(() => runtime);
  const guest = vi.spyOn(api.computers, 'guest');
  const invoke = vi.spyOn(api.capabilities, 'invoke').mockResolvedValue({ ok: true });
  const tick = () => api.capabilities.schedules.tick(api.capabilities.list('default'));
  tick();
  expect(invoke).not.toHaveBeenCalled();
  runtime = 'boot-1';
  tick();
  tick();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith(
    item.id,
    expect.objectContaining({ trigger: 'workspace_start', runtimeId: 'boot-1' }),
    'runJob',
  );
  runtime = undefined;
  tick();
  runtime = 'boot-1';
  tick();
  expect(invoke).toHaveBeenCalledTimes(1);
  runtime = 'boot-2';
  tick();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(guest).not.toHaveBeenCalled();
});
it('consumes once schedules across code updates, disable/enable, and backend restarts', async () => {
  const marker = join(folder, 'once.txt');
  const runAt = new Date(Date.now() - 1000).toISOString();
  const code = `import {appendFileSync} from 'node:fs'; ${source(`[{type:'once',runAt:${JSON.stringify(runAt)}}]`, `appendFileSync(${JSON.stringify(marker)},event.trigger+'\\n'); return event;`)}`;
  const item = await register(code);
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  await waitFor(() => api.capabilities.detail(item.id, 'default').runs[0]?.status === 'complete');
  expect(readFileSync(marker, 'utf8')).toBe('once\n');
  expect(api.capabilities.detail(item.id, 'default').registration.nextRunAt).toBeNull();
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: item.id });
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'disable', id: item.id });
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'enable', id: item.id });
  await close();
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(api.capabilities.detail(item.id, 'default').registration.nextRunAt).toBeNull();
  expect(readFileSync(marker, 'utf8')).toBe('once\n');
  const nextAt = new Date(Date.now() - 2000).toISOString();
  writeFileSync(join(folder, 'job.ts'), code.replace(runAt, nextAt));
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: item.id });
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  await waitFor(
    () =>
      api.capabilities.detail(item.id, 'default').runs.filter((r) => r.status === 'complete')
        .length === 2,
  );
  expect(readFileSync(marker, 'utf8')).toBe('once\nonce\n');
});
it('keeps future once jobs pending, consumes manual attempts, and does not retry failures', async () => {
  const future = new Date(Date.now() + 60000).toISOString();
  const item = await register(
    source(
      `[{type:'once',runAt:${JSON.stringify(future)}}]`,
      "throw new Error('One shot failed');",
    ),
  );
  api.capabilities.schedules.tick(api.capabilities.list('default'));
  expect(api.capabilities.detail(item.id, 'default').runs).toHaveLength(0);
  await expect(
    api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: item.id }),
  ).rejects.toThrow('One shot failed');
  api.capabilities.schedules.tick(api.capabilities.list('default'), Date.now() + 120000);
  expect(api.capabilities.detail(item.id, 'default').runs).toHaveLength(1);
  expect(api.capabilities.detail(item.id, 'default').registration.nextRunAt).toBeNull();
  writeFileSync(
    join(folder, 'job.ts'),
    source(`[{type:'once',runAt:${JSON.stringify(future)}},{type:'workspace_start'}]`),
  );
  await expect(
    api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: item.id }),
  ).rejects.toThrow('only trigger');
});
it('enforces job timeouts and releases the execution lock', async () => {
  const item = await register(
    source()
      .replace('async run', 'timeoutMs:100,async run')
      .replace('return event;', 'await new Promise(()=>{});'),
  );
  await expect(
    api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: item.id }),
  ).rejects.toThrow('timed out');
  expect(api.capabilities.schedules.busy(item.id)).toBe(false);
  expect(api.capabilities.detail(item.id, 'default').runs[0].status).toBe('failed');
});
it('provides workspacePath to job, queued-handler and route contexts without relying on cwd', async () => {
  const route = await register(
    `import {join} from 'node:path'; import {writeFileSync} from 'node:fs';
    export default {name:'path_route',method:'GET',path:'/custom/path-probe',auth:'mukai',handle(request,context){
      writeFileSync(join(context.workspacePath,'route-path.txt'),'route'); return {status:200,body:context.workspacePath};
    }}`,
    'route',
    'path-route.ts',
  );
  const job = await register(`import {join} from 'node:path'; import {writeFileSync} from 'node:fs';
    export default {name:'path_job',description:'Write within the workspace',triggers:[{type:'workspace_start'}],
      async run(event,context){
        writeFileSync(join(context.workspacePath,'job-path.txt'),'job');
        const response=await context.callRoute(${JSON.stringify(route.id)});
        await context.enqueue('path-test','event',{value:'queued'});
        return {path:context.workspacePath,routePath:response.body};
      },processJob(payload,context){writeFileSync(join(context.workspacePath,'queue-path.txt'),payload.value);}
    }`);
  expect(
    await api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: job.id }),
  ).toEqual({ result: { path: folder, routePath: folder } });
  await waitFor(() => existsSync(join(folder, 'queue-path.txt')));
  expect(readFileSync(join(folder, 'job-path.txt'), 'utf8')).toBe('job');
  expect(readFileSync(join(folder, 'route-path.txt'), 'utf8')).toBe('route');
  expect(readFileSync(join(folder, 'queue-path.txt'), 'utf8')).toBe('queued');
});
it('reports execution failures in list and inspect without changing configuration readiness, and resets them after success', async () => {
  const job = await register(
    source("[{type:'workspace_start'}]", "throw new Error('Expected path failure');"),
  );
  const run = () =>
    api.capabilities.manage('default', 'scout', 'job', { operation: 'run_now', id: job.id });
  for (let count = 1; count <= 3; count++) {
    await expect(run()).rejects.toThrow('Expected path failure');
    const saved = api.capabilities.list('default').find((item) => item.id === job.id)!;
    expect(saved.status).toBe('ready');
    expect(saved.health).toMatchObject({
      consecutiveFailures: count,
      lastError: 'Expected path failure',
      lastRun: { status: 'failed', error: 'Expected path failure' },
    });
    expect(api.capabilities.detail(job.id, 'default').registration.health).toEqual(saved.health);
  }
  writeFileSync(join(folder, 'job.ts'), source("[{type:'workspace_start'}]"));
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'update', id: job.id });
  expect(api.capabilities.detail(job.id, 'default').registration.health?.consecutiveFailures).toBe(
    3,
  );
  await run();
  expect(api.capabilities.detail(job.id, 'default').registration.health).toMatchObject({
    consecutiveFailures: 0,
    lastError: null,
    lastRun: { status: 'complete' },
  });
});
it('hides due times while disabled or missing configuration and preserves a pending once schedule', async () => {
  const runAt = new Date(Date.now() + 60000).toISOString();
  const job = await register(
    source(`[{type:'once',runAt:${JSON.stringify(runAt)}}]`).replace(
      'async run',
      "requiredEnv:['MISSING_TOKEN'],async run",
    ),
  );
  expect(job.status).toBe('needs_configuration');
  expect(job.nextRunAt).toBeNull();
  api.capabilities.environment.save('default', [{ name: 'MISSING_TOKEN', value: 'dummy-token' }]);
  expect(api.capabilities.list('default')[0].nextRunAt).toBe(runAt);
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'disable', id: job.id });
  expect(api.capabilities.list('default')[0].nextRunAt).toBeNull();
  expect(
    api.store.get('SELECT next_at FROM capability_schedules WHERE capability_id=?', job.id)
      ?.next_at,
  ).toBe(Date.parse(runAt));
  await api.capabilities.manage('default', 'scout', 'job', { operation: 'enable', id: job.id });
  expect(api.capabilities.list('default')[0].nextRunAt).toBe(runAt);
});
