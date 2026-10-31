import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QemuComputer, type QemuConfig } from '../src/server/computer/qemuComputer';
import { startApiServer } from '../src/server/app';
import { computerTools } from '../src/server/computer/tools';
import { seedTestBot } from '../src/server/testFixtures';
import type { CapabilityRegistration } from '../src/shared/customCapabilities';

/** Opt-in live check: copies the prepared base; never opens a personal workspace disk. */
async function main() {
  const index = process.argv.indexOf('--data-dir');
  if (index < 0 || !process.argv[index + 1]) {
    console.log(
      'Usage: npm run test:capabilities:vm -- --data-dir PATH\nRequires a prepared VM base and npm run build:guest. Uses a disposable copy.',
    );
    return;
  }
  const dataDir = resolve(process.argv[index + 1]);
  const config = JSON.parse(
    await readFile(join(dataDir, 'computer-setup/ready.json'), 'utf8'),
  ) as QemuConfig;
  config.image = await realpath(config.image);
  assert.notEqual(
    basename(config.image).toLowerCase(),
    'disk.qcow2',
    'Refusing a personal workspace disk.',
  );
  assert.ok(
    !/[\\/](computers|workspaces)[\\/]/i.test(config.image),
    'Refusing a personal workspace disk.',
  );
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'mukai-capability-vm-'));
  const vm = new QemuComputer(join(directory, 'vm'), config, undefined, resolve('dist/guest'));
  let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
  const signal = AbortSignal.timeout(300000);
  const owner = { workspaceId: 'default', botId: 'scout', conversationId: 'vm-smoke' };
  const write = (path: string, content: string) =>
    vm.request('files', { action: 'write_file', path, content, overwrite: true }, owner, signal);
  try {
    console.log('Booting and updating a disposable Linux base copy.');
    await vm.start();
    api = await startApiServer(0, { dataDir: join(directory, 'controller') });
    seedTestBot(api.store);
    api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
    api.computers.guest = () => vm;
    api.computers.runtimeId = () => vm.runtimeId();
    api.capabilities.setWake(async () => {});
    console.log('Registering a tool with a guest TypeScript dependency.');
    await write('math.ts', 'export function multiply(a:number,b:number){return a*b;}');
    await write(
      'multiply.ts',
      `import {multiply} from './math';
      export default {name:'guest_multiply',description:'Multiply two numbers inside Linux',
        inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false},
        execute(args){return {product:multiply(args.a,args.b),platform:process.platform,file:__filename};}};`,
    );
    const item = (await api.capabilities.manage(
      'default',
      'scout',
      'tool',
      {
        operation: 'register',
        modulePath: 'multiply.ts',
        permissionMode: 'auto_approve',
      },
      signal,
    )) as CapabilityRegistration;
    assert.equal(item.status, 'ready');
    const result = (await api.capabilities.invoke(item.id, { a: 6, b: 7 }, 'execute', signal)) as {
      product: number;
      platform: string;
      file: string;
    };
    assert.equal(result.product, 42);
    assert.equal(result.platform, 'linux');
    assert.ok(result.file.startsWith('/var/lib/mukai-guest/capability-staging/'));
    console.log('Forwarding an authenticated webhook and persisting guest helpers.');
    await write(
      'webhook.js',
      `import {writeFileSync} from 'node:fs';
      export default {name:'guest_webhook',method:'POST',path:'/custom/vm-smoke',auth:'mukai',
        async handle(request,context){
          const job=await context.enqueue('smoke','event-1',{hex:request.rawBody.toString('hex')});
          await context.wakeBot('Smoke event received',{botId:'scout'});
          return {status:202,body:{job,platform:process.platform,authorizationPresent:'authorization' in request.headers}};
        },
        processJob(payload){writeFileSync('/home/mukai/workspace/webhook-result.txt',payload.hex);return {done:true};}};`,
    );
    const route = (await api.capabilities.manage(
      'default',
      'scout',
      'route',
      {
        operation: 'register',
        modulePath: 'webhook.js',
      },
      signal,
    )) as CapabilityRegistration;
    const raw = '{ "message": "café 🌱" }\r\n';
    const response = await fetch(api.url + '/custom/vm-smoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: raw,
      signal,
    });
    assert.equal(response.status, 202);
    const received = (await response.json()) as {
      platform: string;
      authorizationPresent: boolean;
      job: { id: string };
    };
    assert.equal(received.platform, 'linux');
    assert.equal(received.authorizationPresent, false);
    console.log(
      'Testing automatic route credentials against the real VM gateway and ephemeral port.',
    );
    await write(
      'route-access.js',
      `export default {name:'route_access',method:'GET',path:'/custom/route-access',auth:'mukai',handle(request){return {status:200,body:{ok:true,authorizationPresent:'authorization' in request.headers}}}};`,
    );
    await api.capabilities.manage(
      'default',
      'scout',
      'route',
      { operation: 'register', modulePath: 'route-access.js' },
      signal,
    );
    await write(
      'route-client.js',
      `export default {name:'route_client',description:'VM route credentials',inputSchema:{type:'object'},async execute(args,context){
      const url=context.env.MUKAI_ROUTES_URL;
      const response=await fetch(url+'/custom/route-access',{headers:{Authorization:'Bearer '+context.env.MUKAI_ROUTES_TOKEN}});
      return {url,status:response.status,body:await response.json(),token:context.env.MUKAI_ROUTES_TOKEN};
    }};`,
    );
    const client = (await api.capabilities.manage(
      'default',
      'scout',
      'tool',
      { operation: 'register', modulePath: 'route-client.js', permissionMode: 'auto_approve' },
      signal,
    )) as CapabilityRegistration;
    const gateway = 'http://10.0.2.2:' + new URL(api.url).port;
    assert.deepEqual(await api.capabilities.invoke(client.id, {}, 'execute', signal), {
      url: gateway,
      status: 200,
      body: { ok: true, authorizationPresent: false },
      token: '[redacted]',
    });
    const routeTools = computerTools({
      owner,
      signal,
      onActivity: () => {},
      budget: { remaining: 10 },
      computer: vm,
      vision: false,
      fileBudget: { remaining: 10 },
      recordChange: () => {},
      recordFile: () => {},
      saveScreenshot: async () => {
        throw new Error('unused');
      },
      routeEnvironment: () => api!.capabilities.routeEnvironment('default'),
    });
    const terminal = (await routeTools.terminal.execute!(
      {
        command:
          'curl --fail --silent -H "Authorization: Bearer $MUKAI_ROUTES_TOKEN" "$MUKAI_ROUTES_URL/custom/route-access"',
        yieldMs: 30000,
      },
      { toolCallId: 'vm-route-access', messages: [], context: undefined },
    )) as { result: { exitCode: number; output: string } };
    assert.equal(terminal.result.exitCode, 0);
    assert.deepEqual(JSON.parse(terminal.result.output), { ok: true, authorizationPresent: false });
    console.log('Calling a protected route from a guest-created tool without a token.');
    await write(
      'call-route.js',
      `export default {name:'call_workspace_route',description:'Test a workspace route',inputSchema:{type:'object'},
      execute(args,context){return context.callRoute(args.id,{rawBody:args.rawBody,headers:{'content-type':'application/json'}});}};`,
    );
    const caller = (await api.capabilities.manage(
      'default',
      'scout',
      'tool',
      {
        operation: 'register',
        modulePath: 'call-route.js',
        permissionMode: 'auto_approve',
      },
      signal,
    )) as CapabilityRegistration;
    const called = (await api.capabilities.invoke(
      caller.id,
      { id: route.id, rawBody: raw },
      'execute',
      signal,
    )) as { status: number; body: { platform: string; authorizationPresent: boolean } };
    assert.equal(called.status, 202);
    assert.equal(called.body.platform, 'linux');
    assert.equal(called.body.authorizationPresent, false);
    assert.ok(api.store.get('SELECT id FROM capability_jobs WHERE id=?', received.job.id));
    assert.ok(
      api.store.get(
        "SELECT id FROM capability_jobs WHERE capability_id=? AND provider='__mukai_wake'",
        route.id,
      ),
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        api.capabilities.detail(route.id, 'default').jobs.every((job) => job.status === 'complete')
      )
        break;
      await delay(100, undefined, { signal });
    }
    assert.ok(
      api.capabilities.detail(route.id, 'default').jobs.every((job) => job.status === 'complete'),
    );
    const file = (await vm.request(
      'files',
      { action: 'read_file', path: 'webhook-result.txt' },
      owner,
      signal,
    )) as { result: { content: string } };
    assert.equal(file.result.content, Buffer.from(raw).toString('hex'));
    console.log('Registering and running a custom job through the upgraded guest bridge.');
    api.capabilities.environment.save('default', [{ name: 'JOB_CHECK', value: 'job-smoke-value' }]);
    await write(
      'job.ts',
      `import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
      export default {name:'guest_heartbeat',description:'Disposable job upgrade check',
        triggers:[{type:'interval',intervalMs:1000},{type:'workspace_start'}],requiredEnv:['JOB_CHECK'],
        run(event,context){
          if(context.env.JOB_CHECK!=='job-smoke-value')throw new Error('Missing job environment');
          if(context.workspacePath!=='/home/mukai/workspace')throw new Error('Missing guest workspacePath');
          appendFileSync(join(context.workspacePath,'job-events.txt'),event.trigger+'\\n');
          return {trigger:event.trigger,platform:process.platform,file:__filename};
        }};`,
    );
    const job = (await api.capabilities.manage(
      'default',
      'scout',
      'job',
      {
        operation: 'register',
        modulePath: 'job.ts',
      },
      signal,
    )) as CapabilityRegistration;
    assert.equal(job.kind, 'job');
    assert.equal(job.status, 'ready');
    const manual = (await api.capabilities.manage(
      'default',
      'scout',
      'job',
      {
        operation: 'run_now',
        id: job.id,
      },
      signal,
    )) as { result: { trigger: string; platform: string } };
    assert.deepEqual(
      { trigger: manual.result.trigger, platform: manual.result.platform },
      { trigger: 'manual', platform: 'linux' },
    );
    for (let attempt = 0; attempt < 60; attempt++) {
      if (
        api.capabilities.detail(job.id, 'default').runs.filter((run) => run.status === 'complete')
          .length >= 2
      )
        break;
      await delay(100, undefined, { signal });
    }
    const jobLog = (await vm.request(
      'files',
      { action: 'read_file', path: 'job-events.txt' },
      owner,
      signal,
    )) as { result: { content: string } };
    assert.ok(
      jobLog.result.content.includes('interval\n'),
      'Expected an unattended interval execution.',
    );
    await api.capabilities.manage(
      'default',
      'scout',
      'job',
      { operation: 'disable', id: job.id },
      signal,
    );
    console.log('Checking saved execution after workspace edits and a VM restart.');
    await write('math.ts', 'export function multiply(){return 999;}');
    await vm.stop();
    const restored = (await api.capabilities.invoke(
      item.id,
      { a: 3, b: 5 },
      'execute',
      signal,
    )) as { product: number; platform: string };
    assert.equal(restored.product, 15);
    assert.equal(restored.platform, 'linux');
    await api.capabilities.manage(
      'default',
      'scout',
      'job',
      { operation: 'enable', id: job.id },
      signal,
    );
    // Enable during this runtime waits for the next VM start.
    await vm.stop();
    await vm.start();
    for (let attempt = 0; attempt < 60; attempt++) {
      const log = (await vm.request(
        'files',
        { action: 'read_file', path: 'job-events.txt' },
        owner,
        signal,
      )) as { result: { content: string } };
      if (log.result.content.includes('workspace_start\n')) break;
      await delay(100, undefined, { signal });
    }
    const afterStart = (await vm.request(
      'files',
      { action: 'read_file', path: 'job-events.txt' },
      owner,
      signal,
    )) as { result: { content: string } };
    assert.equal(afterStart.result.content.split('workspace_start\n').length - 1, 1);
    await api.capabilities.manage(
      'default',
      'scout',
      'job',
      { operation: 'disable', id: job.id },
      signal,
    );
    console.log(
      'Linux VM tools/routes/jobs, unattended intervals, startup execution, environment, and restart passed.',
    );
  } finally {
    if (api) {
      await api.shutdown();
      await new Promise<void>((resolve) => api!.server.close(() => resolve()));
      api.dispose();
    }
    await vm.shutdown();
    const target = await realpath(directory);
    assert.equal(dirname(target), parent, 'Unexpected VM cleanup path.');
    assert.ok(basename(target).startsWith('mukai-capability-vm-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
