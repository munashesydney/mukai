import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { GuestDispatcher } from '../computer/guestDispatcher';
import type { QemuComputer } from '../computer/qemuComputer';
import type { CapabilityRegistration } from '../../shared/customCapabilities';
import { WorkspaceRepository } from '../repositories/workspaceRepository';

describe.each(['local', 'qemu'] as const)('%s context.callRoute', (computer) => {
  let api: Awaited<ReturnType<typeof startApiServer>>, guest: GuestDispatcher | undefined;
  let root: string, folder: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'mukai-route-call-')));
    folder = join(root, 'workspace');
    await mkdir(folder);
    api = await startApiServer(0, { dataDir: join(root, 'controller') });
    seedTestBot(api.store);
    api.store.run(
      "UPDATE workspaces SET computer=?,folder=? WHERE id='default'",
      computer,
      computer === 'local' ? folder : null,
    );
    if (computer === 'qemu') {
      guest = new GuestDispatcher(folder, join(root, 'guest'));
      vi.spyOn(api.computers, 'guest').mockReturnValue(guest as unknown as QemuComputer);
    }
  });
  afterEach(async () => {
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    await guest?.shutdown();
    guest = undefined;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  async function register(kind: 'tool' | 'route', name: string, source: string) {
    await writeFile(join(folder, name + '.js'), source);
    return (await api.capabilities.manage('default', 'scout', kind, {
      operation: 'register',
      modulePath: name + '.js',
      ...(kind === 'tool' ? { permissionMode: 'auto_approve' as const } : {}),
    })) as CapabilityRegistration;
  }
  const routeSource = (name: string, handle: string, extra = '', auth = 'mukai') =>
    `export default {name:${JSON.stringify(name)},method:'POST',path:'/custom/${name}',auth:${JSON.stringify(auth)},${extra}async handle(request,context){${handle}}};`;
  async function caller(extra = '', body = 'return context.callRoute(args.id,args.request);') {
    return register(
      'tool',
      'caller',
      `export default {name:'route_caller',description:'Call a workspace route',inputSchema:{type:'object'},${extra}async execute(args,context){${body}}};`,
    );
  }
  const call = (
    tool: CapabilityRegistration,
    route: CapabilityRegistration,
    request: unknown = {},
  ) => api.capabilities.invoke(tool.id, { id: route.id, request });

  it('authorizes internal Mukai calls, normalizes data, and strips credentials from HTTP handlers too', async () => {
    const route = await register(
      'route',
      'private_ping',
      routeSource(
        'private_ping',
        "return {status:201,headers:{'x-result':'ok'},body:{method:request.method,url:request.url,body:request.body,raw:request.rawBody.toString(),hasAuthorization:'authorization' in request.headers,header:request.headers['x-test']}};",
      ),
    );
    const tool = await caller();
    expect(
      await call(tool, route, {
        body: { value: '🌱' },
        query: { term: 'a b&c' },
        headers: { Authorization: 'do-not-forward', 'X-Test': 'hello' },
      }),
    ).toEqual({
      status: 201,
      headers: { 'x-result': 'ok' },
      body: {
        method: 'POST',
        url: '/custom/private_ping?term=a+b%26c',
        body: { value: '🌱' },
        raw: '{"value":"🌱"}',
        hasAuthorization: false,
        header: 'hello',
      },
    });
    expect((await fetch(api.url + '/custom/private_ping', { method: 'POST' })).status).toBe(401);
    const response = await fetch(api.url + '/custom/private_ping', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token },
    });
    expect(response.status).toBe(201);
    expect((await response.json()).hasAuthorization).toBe(false);
  });
  it('returns public handler error statuses unchanged', async () => {
    const route = await register(
      'route',
      'public_route',
      routeSource('public_route', "return {status:422,body:{error:'bad input'}};", '', 'public'),
    );
    expect(await call(await caller(), route)).toEqual({
      status: 422,
      body: { error: 'bad input' },
    });
  });
  it('preserves signature verification, provider authentication and exact UTF-8 webhook bytes', async () => {
    const marker = join(folder, 'signed-effects.txt');
    const route = await register(
      'route',
      'signed_route',
      `import {createHmac} from 'node:crypto';import {appendFileSync} from 'node:fs';
      ${routeSource('signed_route', `if(request.headers['x-signature']!==createHmac('sha256',context.env.SIGNING_SECRET).update(request.rawBody).digest('hex'))return {status:401};appendFileSync(${JSON.stringify(marker)},'called');return {status:200,body:{raw:request.rawBody.toString(),parsed:request.body,authorization:request.headers.authorization}};`, "requiredEnv:['SIGNING_SECRET'],", 'handler')}`,
    );
    api.capabilities.environment.save('default', [
      { name: 'SIGNING_SECRET', value: 'test-signing-secret' },
    ]);
    const tool = await caller();
    const rawBody = '{ "value": "café 🌱" }\r\n';
    expect(
      await call(tool, route, { rawBody, headers: { 'content-type': 'application/json' } }),
    ).toEqual({ status: 401, body: null });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const signature = createHmac('sha256', 'test-signing-secret').update(rawBody).digest('hex');
    expect(
      await call(tool, route, {
        rawBody,
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          Authorization: 'provider-auth',
        },
      }),
    ).toEqual({
      status: 200,
      body: { raw: rawBody, parsed: { value: 'café 🌱' }, authorization: 'provider-auth' },
    });
    expect(await readFile(marker, 'utf8')).toBe('called');
  });
  it('rejects other workspaces, non-routes, disabled routes and missing configuration', async () => {
    const tool = await caller();
    await expect(api.capabilities.invoke(tool.id, { id: 'missing' })).rejects.toThrow('not found');
    await expect(call(tool, tool)).rejects.toThrow('registered route ID');
    const route = await register(
      'route',
      'scoped_route',
      routeSource('scoped_route', 'return {status:200};'),
    );
    new WorkspaceRepository(api.store).create({
      id: 'other',
      name: 'Other',
      computer,
      folder: null,
      createdAt: new Date().toISOString(),
    });
    api.store.run('UPDATE capabilities SET workspace_id=? WHERE id=?', 'other', route.id);
    await expect(call(tool, route)).rejects.toThrow('not found');
    api.store.run('UPDATE capabilities SET workspace_id=? WHERE id=?', 'default', route.id);
    await api.capabilities.manage('default', 'scout', 'route', {
      operation: 'disable',
      id: route.id,
    });
    await expect(call(tool, route)).rejects.toThrow('disabled');
    const missing = await register(
      'route',
      'missing_env',
      routeSource('missing_env', 'return {status:200};', "requiredEnv:['UNCONFIGURED'],"),
    );
    await expect(call(tool, missing)).rejects.toThrow('Needs configuration');
    expect(api.capabilities.detail(route.id, 'default').runs).toHaveLength(0);
  });
  it('rejects malformed requests, reserved headers and oversized data', async () => {
    const tool = await caller();
    const route = await register(
      'route',
      'validation_route',
      routeSource('validation_route', 'return {status:200};'),
    );
    for (const request of [
      { body: {}, rawBody: '{}' },
      { url: 'http://example.com' },
      { headers: { Host: 'example.com' } },
      { headers: { 'x-value': 'bad\nvalue' } },
      { headers: { 'X-Test': 'a', 'x-test': 'b' } },
    ])
      await expect(call(tool, route, request)).rejects.toThrow();
    await expect(call(tool, route, { rawBody: 'x'.repeat(262144) })).rejects.toThrow('256');
    expect(api.capabilities.detail(route.id, 'default').runs).toHaveLength(0);
  });
  it('supports route handlers and background jobs calling routes with target-scoped environment', async () => {
    const effects = join(folder, 'job-effects.txt');
    const target = await register(
      'route',
      'job_target',
      `import {appendFileSync} from 'node:fs';${routeSource('job_target', `appendFileSync(${JSON.stringify(effects)},request.body.value+'\\n');return {status:200,body:{targetEnv:!!context.env.TARGET_SECRET,parentEnv:!!context.env.PARENT_SECRET}};`, "requiredEnv:['TARGET_SECRET'],")}`,
    );
    const source = `export default {name:'job_source',method:'POST',path:'/custom/job_source',auth:'mukai',requiredEnv:['PARENT_SECRET'],
      async handle(request,context){if(request.body.queue)return {status:202,body:await context.enqueue('fixture','job-1',{value:'job'})};return context.callRoute(${JSON.stringify(target.id)},{body:request.body});},
      async processJob(payload,context){return context.callRoute(${JSON.stringify(target.id)},{body:payload});}};`;
    const sourceRoute = await register('route', 'job_source', source);
    api.capabilities.environment.save('default', [
      { name: 'TARGET_SECRET', value: 'target-secret' },
      { name: 'PARENT_SECRET', value: 'parent-secret' },
    ]);
    const tool = await caller();
    expect(await call(tool, sourceRoute, { body: { value: 'direct' } })).toEqual({
      status: 200,
      body: { targetEnv: true, parentEnv: false },
    });
    expect(await call(tool, sourceRoute, { body: { queue: true } })).toMatchObject({ status: 202 });
    await vi.waitFor(
      () =>
        expect(api.capabilities.detail(sourceRoute.id, 'default').jobs[0].status).toBe('complete'),
      { timeout: 5000 },
    );
    expect(await readFile(effects, 'utf8')).toBe('direct\njob\n');
  });
  it('rejects cycles and enforces four nested calls', async () => {
    const cycle = await register(
      'route',
      'cycle_route',
      routeSource('cycle_route', 'return context.callRoute(request.body.id,{body:request.body});'),
    );
    const tool = await caller();
    await expect(call(tool, cycle, { body: { id: cycle.id } })).rejects.toThrow('cycle');
    const routes: CapabilityRegistration[] = [];
    for (let i = 0; i < 5; i++)
      routes.push(
        await register(
          'route',
          'depth_' + i,
          routeSource(
            'depth_' + i,
            'if(request.body.ids.length)return context.callRoute(request.body.ids[0],{body:{ids:request.body.ids.slice(1)}});return {status:200};',
          ),
        ),
      );
    expect(
      await call(tool, routes[0], { body: { ids: routes.slice(1, 4).map((r) => r.id) } }),
    ).toEqual({ status: 200, body: null });
    await expect(
      call(tool, routes[0], { body: { ids: routes.slice(1).map((r) => r.id) } }),
    ).rejects.toThrow('nesting limit');
  });
  it('shares a sixteen-call budget across parallel branches', async () => {
    const target = await register(
      'route',
      'budget_target',
      routeSource('budget_target', 'return {status:200};'),
    );
    const branch = await register(
      'route',
      'budget_branch',
      routeSource(
        'budget_branch',
        `for(let i=0;i<8;i++)await context.callRoute(${JSON.stringify(target.id)});return {status:200};`,
      ),
    );
    const tool = await caller(
      '',
      `return Promise.all([context.callRoute(${JSON.stringify(branch.id)}),context.callRoute(${JSON.stringify(branch.id)})]);`,
    );
    await expect(api.capabilities.invoke(tool.id, {})).rejects.toThrow('budget exceeded');
    expect(api.capabilities.detail(target.id, 'default').runs.length).toBeLessThanOrEqual(14);
  });
  it.each(['cancel', 'timeout', 'return'] as const)(
    'stops child handlers on parent %s',
    async (reason) => {
      const target = await register(
        'route',
        'hanging_route',
        routeSource('hanging_route', 'return new Promise(()=>{});', 'timeoutMs:5000,'),
      );
      const tool = await caller(
        'timeoutMs:500,',
        reason === 'return'
          ? `context.callRoute(args.id).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,150));return {finished:true};`
          : 'return context.callRoute(args.id);',
      );
      const controller = new AbortController();
      const run = api.capabilities.invoke(tool.id, { id: target.id }, 'execute', controller.signal);
      const outcome =
        reason === 'return'
          ? expect(run).resolves.toEqual({ finished: true })
          : expect(run).rejects.toThrow(reason === 'cancel' ? 'cancelled' : 'timed out');
      if (reason === 'cancel') {
        await vi.waitFor(() =>
          expect(api.capabilities.detail(target.id, 'default').runs[0]?.status).toBe('running'),
        );
        controller.abort();
      }
      await outcome;
      await vi.waitFor(
        () =>
          expect(api.capabilities.detail(target.id, 'default').runs[0]?.status).toBe('interrupted'),
        { timeout: 2000 },
      );
    },
  );
});
