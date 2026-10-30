import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { GuestDispatcher } from '../computer/guestDispatcher';
import { computerTools } from '../computer/tools';
import type { CapabilityRegistration } from '../../shared/customCapabilities';
import type { QemuComputer } from '../computer/qemuComputer';
import { customRouteReturnTo } from '../../shared/routeAccess';
import { RouteCredentials } from './routeCredentials';

let root: string, folder: string, api: Awaited<ReturnType<typeof startApiServer>>;
const owner = { workspaceId: 'default', botId: 'scout', conversationId: 'probe' };
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mukai-route-access-'));
  folder = join(root, 'workspace');
  const webDir = join(root, 'web');
  await mkdir(folder);
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<html>Mukai login</html>');
  api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
  seedTestBot(api.store);
  api.workspaces.update('default', { name: 'Route access', folder });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await rm(root, { recursive: true, force: true });
});
async function route(name: string, auth = 'mukai', workspaceId = 'default', method = 'GET') {
  await writeFile(
    join(folder, name + '.ts'),
    `export default { name:'${name}', method:'${method}', path:'/custom/${name}', auth:'${auth}', handle(request,context){ return {status:200,body:{ok:true,cookie:request.headers.cookie??null,authorization:request.headers.authorization??null, url:context.env.MUKAI_ROUTES_URL}}; } };`,
  );
  return (await api.capabilities.manage(workspaceId, null, 'route', {
    operation: 'register',
    modulePath: name + '.ts',
  })) as CapabilityRegistration;
}
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
it('binds route credentials to one workspace and rejects them at the management API and session routes', async () => {
  await route('private');
  await route('ui', 'session');
  const otherFolder = join(root, 'other');
  await mkdir(otherFolder);
  const other = api.workspaces.create({ name: 'Other', folder: otherFolder });
  await writeFile(
    join(otherFolder, 'other.ts'),
    `export default {name:'other',method:'GET',path:'/custom/other',auth:'mukai',handle(){return {status:200}}}`,
  );
  await api.capabilities.manage(other.id, null, 'route', {
    operation: 'register',
    modulePath: 'other.ts',
  });
  const lease = api.capabilities.routeEnvironment('default', 60000);
  expect(lease.env.MUKAI_ROUTES_URL).toBe(api.url);
  expect(lease.env.MUKAI_ROUTES_TOKEN).not.toBe(api.token);
  const headers = bearer(lease.env.MUKAI_ROUTES_TOKEN);
  const allowed = await fetch(api.url + '/custom/private', { headers });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ ok: true, authorization: null });
  expect((await fetch(api.url + '/api/workspaces', { headers })).status).toBe(401);
  expect((await fetch(api.url + '/custom/other', { headers })).status).toBe(401);
  expect((await fetch(api.url + '/custom/ui', { headers })).status).toBe(401);
  lease.release();
  expect((await fetch(api.url + '/custom/private', { headers })).status).toBe(401);
});
it('injects the actual port into local terminal processes, masks credentials and revokes them on exit', async () => {
  await route('terminal_target');
  await writeFile(
    join(folder, 'probe.cjs'),
    `const fs=require('node:fs'); (async()=>{
    const token=process.env.MUKAI_ROUTES_TOKEN,url=process.env.MUKAI_ROUTES_URL;
    fs.writeFileSync('token.txt',token);
    const r=await fetch(url+'/custom/terminal_target',{headers:{Authorization:'Bearer '+token}});
    console.log(JSON.stringify({url,status:r.status,token,encoded:Buffer.from(token).toString('base64')}));
  })().catch(e=>{console.error(e);process.exitCode=1});`,
  );
  const result = await api.processes.run(
    owner,
    folder,
    { command: JSON.stringify(process.execPath) + ' probe.cjs', yieldMs: 30000 },
    signal(),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    url: api.url,
    status: 200,
    token: '[redacted]',
    encoded: '[redacted]',
  });
  const token = await readFile(join(folder, 'token.txt'), 'utf8');
  expect(
    (await fetch(api.url + '/custom/terminal_target', { headers: bearer(token) })).status,
  ).toBe(401);
  await expect(
    api.processes.run(
      owner,
      folder,
      { command: 'echo no', env: { MUKAI_ROUTES_TOKEN: 'override' } },
      signal(),
    ),
  ).rejects.toThrow('supplied by Mukai');
});
it('supplies route access to custom workers and children without requiredEnv, and masks returned tokens', async () => {
  await route('worker_target');
  await writeFile(
    join(folder, 'worker.ts'),
    `import {execFileSync} from 'node:child_process';
    export default {name:'worker_probe',description:'Route credentials probe',inputSchema:{type:'object'},async execute(args,context){
      const token=context.env.MUKAI_ROUTES_TOKEN;
      const response=await fetch(context.env.MUKAI_ROUTES_URL+'/custom/worker_target',{headers:{Authorization:'Bearer '+token}});
      return {status:response.status,url:context.env.MUKAI_ROUTES_URL,token,encoded:Buffer.from(token).toString('base64'),child:execFileSync(process.execPath,['-e','process.stdout.write(process.env.MUKAI_ROUTES_TOKEN)']).toString()};
    }};`,
  );
  const item = (await api.capabilities.manage('default', null, 'tool', {
    operation: 'register',
    modulePath: 'worker.ts',
    permissionMode: 'auto_approve',
  })) as CapabilityRegistration;
  expect(await api.capabilities.invoke(item.id, {}, 'execute')).toEqual({
    status: 200,
    url: api.url,
    token: '[redacted]',
    encoded: '[redacted]',
    child: '[redacted]',
  });
});
it('gives VM terminals and workers the gateway URL with the bound port and supports it without a Host override', async () => {
  api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
  const guest = new GuestDispatcher(folder, join(root, 'guest'));
  vi.spyOn(api.computers, 'guest').mockReturnValue({
    request: guest.request.bind(guest),
    requestRunning: guest.request.bind(guest),
  } as unknown as QemuComputer);
  try {
    const item = await route('guest_probe');
    const port = new URL(api.url).port;
    const output = (await api.capabilities.invoke(
      item.id,
      { headers: {}, rawBody: Buffer.alloc(0) },
      'handle',
    )) as { body: { url: string } };
    expect(output.body.url).toBe('http://10.0.2.2:' + port);
    const lease = api.capabilities.routeEnvironment('default', 60000);
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          api.url + '/custom/guest_probe',
          { headers: { ...bearer(lease.env.MUKAI_ROUTES_TOKEN), Host: host } },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode!));
          },
        );
        request.on('error', reject);
        request.end();
      });
    expect(await status('10.0.2.2:' + port)).toBe(200);
    expect(await status('10.0.2.2:1')).toBe(403);
    lease.release();
    const tools = computerTools({
      owner,
      signal: signal(),
      onActivity: () => {},
      budget: { remaining: 10 },
      computer: guest,
      vision: false,
      fileBudget: { remaining: 10 },
      recordChange: () => {},
      recordFile: () => {},
      saveScreenshot: async () => {
        throw new Error('unused');
      },
      routeEnvironment: (ttl, active) => api.capabilities.routeEnvironment('default', ttl, active),
      isTerminalRunning: async (id) =>
        (
          (await guest.request('process', { action: 'poll', sessionId: id }, owner, signal())) as {
            status: string;
          }
        ).status === 'running',
    });
    await writeFile(
      join(folder, 'guest-probe.cjs'),
      `console.log(JSON.stringify({url:process.env.MUKAI_ROUTES_URL,token:process.env.MUKAI_ROUTES_TOKEN}));`,
    );
    const result = (await tools.terminal.execute!(
      { command: JSON.stringify(process.execPath) + ' guest-probe.cjs', yieldMs: 30000 },
      { toolCallId: 'guest-terminal', messages: [], context: undefined },
    )) as { result: { output: string } };
    expect(JSON.parse(result.result.output)).toEqual({
      url: 'http://10.0.2.2:' + port,
      token: '[redacted]',
    });
  } finally {
    await guest.shutdown();
  }
});
it('expires leases, checks guest process liveness, and revokes workspace credentials', async () => {
  const active = vi.fn(async () => true),
    untrack = vi.fn();
  const credentials = new RouteCredentials(() => untrack);
  try {
    const lease = credentials.issue('a', api.url, 60000, active),
      token = lease.env.MUKAI_ROUTES_TOKEN;
    expect(await credentials.authorized(token, 'b')).toBe(false);
    expect(active).not.toHaveBeenCalled();
    expect(await credentials.authorized(token, 'a')).toBe(true);
    active.mockResolvedValue(false);
    expect(await credentials.authorized(token, 'a')).toBe(false);
    expect(untrack).toHaveBeenCalledTimes(1);
    const expiring = credentials.issue('a', api.url, 5);
    await vi.waitFor(async () =>
      expect(await credentials.authorized(expiring.env.MUKAI_ROUTES_TOKEN, 'a')).toBe(false),
    );
    const stopped = credentials.issue('a', api.url, 60000);
    credentials.stopWorkspace('a');
    expect(await credentials.authorized(stopped.env.MUKAI_ROUTES_TOKEN, 'a')).toBe(false);
  } finally {
    credentials.close();
  }
});
it('only allows local custom-route return destinations', () => {
  expect(customRouteReturnTo('/custom/ui?ticket=1#draft')).toBe('/custom/ui?ticket=1#draft');
  for (const value of [
    'https://evil.test/custom/ui',
    '//evil.test/custom/ui',
    '/api/settings',
    '/custom/../../api/settings',
    '/custom/%2e%2e/%2e%2e/api/settings',
    '/custom/%5c/evil',
    '/custom/ui%0d%0aLocation:evil',
  ])
    expect(customRouteReturnTo(value)).toBeUndefined();
});
it('protects owner UI and action endpoints with Mukai login and immediately honors logout', async () => {
  await route('owner_ui', 'session');
  await route('owner_action', 'session', 'default', 'POST');
  const visit = () =>
    new Promise<{ status: number; headers: Headers }>((resolve, reject) => {
      const request = httpRequest(
        api.url + '/custom/owner_ui?ticket=2',
        { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } },
        (response) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(',') : value);
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode!, headers }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  const first = await visit();
  expect(first.status).toBe(302);
  expect(first.headers.get('location')).toBe('/?mukai-returnTo=%2Fcustom%2Fowner_ui%3Fticket%3D2');
  expect(first.headers.get('cache-control')).toBe('no-store');
  const missing = await fetch(api.url + '/custom/owner_ui', {
    headers: { Accept: 'application/json' },
  });
  expect(missing.status).toBe(401);
  expect(
    (await fetch(api.url + '/custom/owner_ui', { headers: { Cookie: 'mukai_owner_fake=forged' } }))
      .status,
  ).toBe(401);
  const auth = async (action: string, body: unknown, cookie = '') =>
    fetch(api.url + '/api/auth/' + action, {
      method: 'POST',
      headers: { Origin: api.url, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  const proof = await auth('verify', { code: api.ownerAuth!.setupCode });
  const proofCookie = proof.headers.get('set-cookie')!.split(';')[0];
  const credentials = { username: 'owner', password: 'a sufficient test password' };
  const setup = await auth('setup', credentials, proofCookie);
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const page = await fetch(api.url + '/custom/owner_ui', { headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({ ok: true, cookie: null, authorization: null });
  expect(
    (
      await fetch(api.url + '/custom/owner_action', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: api.url },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(api.url + '/custom/owner_action', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(api.url + '/custom/owner_action', { method: 'POST', headers: { Cookie: cookie } }))
      .status,
  ).toBe(403);
  expect((await auth('logout', {}, cookie)).status).toBe(200);
  expect((await fetch(api.url + '/custom/owner_ui', { headers: { Cookie: cookie } })).status).toBe(
    401,
  );
  expect((await auth('login', credentials)).status).toBe(200);
  expect((await visit()).status).toBe(302);
});
it('permits the existing local connection cookie only until owner login is configured', async () => {
  await route('legacy_ui', 'session');
  const connect = await fetch(api.url + '/api/session', {
    method: 'POST',
    headers: { Origin: api.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: api.browserSession!.connectToken }),
  });
  const cookie = connect.headers.get('set-cookie')!.split(';')[0];
  expect((await fetch(api.url + '/custom/legacy_ui', { headers: { Cookie: cookie } })).status).toBe(
    200,
  );
});

it('checks browser sessions on the configured public origin and rejects a different origin', async () => {
  await route('remote_ui', 'session');
  api.capabilities.saveRouteSettings({ publicBaseUrl: 'https://mukai.example' });
  const local = await fetch(api.url + '/api/auth/verify', {
    method: 'POST',
    headers: { Origin: api.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: api.ownerAuth!.setupCode }),
  });
  const setup = await fetch(api.url + '/api/auth/setup', {
    method: 'POST',
    headers: {
      Origin: api.url,
      'Content-Type': 'application/json',
      Cookie: local.headers.get('set-cookie')!.split(';')[0],
    },
    body: JSON.stringify({ username: 'owner', password: 'a test-only secure password' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const get = (origin: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        api.url + '/custom/remote_ui',
        { headers: { Host: 'mukai.example', Origin: origin, Cookie: cookie } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      request.on('error', reject);
      request.end();
    });
  expect(await get('https://mukai.example')).toBe(200);
  expect(await get('https://evil.example')).toBe(403);
});

it('supports owner login from the VM gateway at the bound port without allowing arbitrary remote HTTP login', async () => {
  await route('gateway_ui', 'session');
  const host = '10.0.2.2:' + new URL(api.url).port;
  const call = (path: string, body?: unknown, cookie = '', requestHost = host) =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const request = httpRequest(
        api.url + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Host: requestHost,
            Origin: 'http://' + requestHost,
            Cookie: cookie,
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              cookie: (response.headers['set-cookie']?.[0] || '').split(';')[0],
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  expect(
    (await call('/api/auth/verify', { code: api.ownerAuth!.setupCode }, '', '10.0.2.2:1')).status,
  ).toBe(403);
  expect(
    (await call('/api/auth/verify', { code: api.ownerAuth!.setupCode }, '', 'remote.example'))
      .status,
  ).toBe(403);
  const proof = await call('/api/auth/verify', { code: api.ownerAuth!.setupCode });
  expect(proof.status).toBe(200);
  const setup = await call(
    '/api/auth/setup',
    { username: 'owner', password: 'a secure test-only password' },
    proof.cookie,
  );
  expect(setup.status).toBe(200);
  expect((await call('/custom/gateway_ui', undefined, setup.cookie)).status).toBe(200);
  expect((await call('/api/instance', undefined, setup.cookie)).status).toBe(200);
});
