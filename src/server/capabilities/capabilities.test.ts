import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startApiServer } from '../app';
import type { CapabilityRegistration } from '../../shared/customCapabilities';
import type { ChatEvent } from '../../shared/ai';

let api: Awaited<ReturnType<typeof startApiServer>>, root: string, folder: string;
let fixture: Server | undefined;
async function request(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, value: await response.json() };
}
function toolSource(name = 'echo', body = 'return args;', requiredEnv: string[] = []) {
  return `export default {name:${JSON.stringify(name)},description:'Echo an input',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},requiredEnv:${JSON.stringify(requiredEnv)},async execute(args,context){${body}}};`;
}
async function register(
  kind: 'tool' | 'route',
  source: string,
  file = 'module.ts',
  ownerBotId?: string,
) {
  writeFileSync(join(folder, file), source);
  const result = await request('/capabilities', 'POST', {
    kind,
    operation: 'register',
    modulePath: file,
    ownerBotId,
  });
  expect(result.status, JSON.stringify(result.value)).toBe(200);
  return result.value as CapabilityRegistration;
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for background job.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-capabilities-'));
  folder = join(root, 'workspace');
  mkdirSync(folder);
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  const result = await request('/workspaces/default', 'PUT', { name: 'Personal', folder });
  expect(result.status).toBe(200);
});
afterEach(async () => {
  if (fixture) {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture!.close(() => resolve()));
    fixture = undefined;
  }
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  expect(root.startsWith(join(tmpdir(), 'mukai-capabilities-'))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
describe('Custom capabilities', () => {
  it('prevents custom registrations from replacing the built-in memory family', async () => {
    writeFileSync(join(folder, 'memory.ts'), toolSource('memory'));
    const result = await request('/capabilities', 'POST', {
      kind: 'tool',
      operation: 'register',
      modulePath: 'memory.ts',
    });
    expect(result.status).toBe(409);
    expect(api.capabilities.list('default')).toHaveLength(0);
  });
  it('creates new tool and route registrations even when a suggested ID is supplied', async () => {
    for (const kind of ['tool', 'route'] as const) {
      const file = kind + '.js';
      writeFileSync(
        join(folder, file),
        kind === 'tool'
          ? toolSource('weather')
          : `export default {name:'weather_route',method:'POST',path:'/custom/weather',auth:'public',handle:()=>({status:200,body:{ok:true}})};`,
      );
      const result = await request('/capabilities', 'POST', {
        kind,
        operation: 'register',
        id: 'weather',
        modulePath: file,
        exportName: 'default',
      });
      expect(result.status, JSON.stringify(result.value)).toBe(200);
      expect(result.value.id).not.toBe('weather');
      const duplicate = await request('/capabilities', 'POST', {
        kind,
        operation: 'register',
        id: result.value.id,
        modulePath: file,
      });
      expect(duplicate.status).toBe(409);
      expect(
        api.capabilities.list('default').find((item) => item.id === result.value.id)?.version,
      ).toBe(result.value.version);
      expect(
        (await request('/capabilities', 'POST', { kind, operation: 'update', id: 'weather' }))
          .status,
      ).toBe(404);
    }
  });
  it('loads actual TS/JS files and bundled local imports without invoking execute during registration', async () => {
    writeFileSync(join(folder, 'helper.ts'), 'export const suffix: string = "-compiled";');
    const item = await register(
      'tool',
      `import {suffix} from './helper'; ${toolSource('echo', 'return {value:args.value+suffix};')}`,
    );
    expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
    expect(
      (await request('/capabilities/' + item.id + '/test', 'POST', { value: 'hello' })).value,
    ).toEqual({ value: 'hello-compiled' });
    expect((await request('/capabilities/' + item.id + '/test', 'POST', { value: 4 })).status).toBe(
      400,
    );
    const js = await register('tool', toolSource('js_echo'), 'javascript.js');
    expect(await api.capabilities.invoke(js.id, { value: 'js' })).toEqual({ value: 'js' });
  });
  it('scopes and rotates encrypted secrets and keeps their values out of public results', async () => {
    const item = await register(
      'tool',
      toolSource(
        'configured',
        `return {configured:context.env.KEY==='first-private-value',extra:context.env.EXTRA ?? null,global:process.env.KEY ?? null,leak:context.env.KEY};`,
        ['KEY'],
      ),
    );
    expect(item.status).toBe('needs_configuration');
    expect(
      (await request('/capabilities/' + item.id + '/test', 'POST', { value: 'x' })).status,
    ).toBe(409);
    await request('/environment', 'PUT', {
      entries: [
        { name: 'KEY', value: 'first-private-value' },
        { name: 'EXTRA', value: 'other-private-value' },
      ],
    });
    const result = await api.capabilities.invoke(item.id, { value: 'x' });
    expect(api.capabilities.environment.publicValue({ 'first-private-value': true })).toEqual({
      '[redacted]': true,
    });
    expect(result).toEqual({ configured: true, extra: null, global: null, leak: '[redacted]' });
    expect(JSON.stringify((await request('/environment')).value)).not.toContain('private-value');
    expect(JSON.stringify(api.store.all('SELECT value FROM capability_env'))).not.toContain(
      'private-value',
    );
    await request('/environment', 'PUT', {
      entries: [{ name: 'KEY', value: 'second-private-value' }],
    });
    expect(await api.capabilities.invoke(item.id, { value: 'x' })).toMatchObject({
      configured: false,
    });
    await request('/environment/KEY', 'DELETE');
    expect(api.capabilities.list('default')[0].status).toBe('needs_configuration');
  });
  it('preserves working versions on invalid updates and permits existing calls to finish', async () => {
    const item = await register(
      'tool',
      toolSource(
        'echo',
        `await new Promise(resolve=>setTimeout(resolve,200));return {value:'old'};`,
      ),
    );
    const running = api.capabilities.invoke(item.id, { value: 'x' });
    writeFileSync(join(folder, 'module.ts'), 'export default {name:"broken"}');
    expect(
      (await request('/capabilities', 'POST', { kind: 'tool', operation: 'update', id: item.id }))
        .status,
    ).toBe(400);
    expect(api.capabilities.list('default')[0].version).toBe(item.version);
    writeFileSync(join(folder, 'module.ts'), toolSource('echo', `return {value:'new'};`));
    expect(
      (await request('/capabilities', 'POST', { kind: 'tool', operation: 'update', id: item.id }))
        .status,
    ).toBe(200);
    expect(await running).toEqual({ value: 'old' });
    expect(await api.capabilities.invoke(item.id, { value: 'x' })).toEqual({ value: 'new' });
  });
  it('rejects collisions, built-ins, invalid schemas, missing packages, and ownership changes', async () => {
    const item = await register('tool', toolSource(), 'first.ts', 'scout');
    writeFileSync(join(folder, 'duplicate.ts'), toolSource());
    expect(
      (
        await request('/capabilities', 'POST', {
          kind: 'tool',
          operation: 'register',
          modulePath: 'duplicate.ts',
        })
      ).status,
    ).toBe(409);
    await expect(
      api.capabilities.manage('default', 'another-bot', 'tool', {
        operation: 'disable',
        id: item.id,
      }),
    ).rejects.toThrow('Only the owner');
    for (const source of [
      toolSource('terminal'),
      toolSource('invalid').replace("type:'object'", "type:'impossible'"),
      `import absent from 'missing-capability-package';${toolSource('missing', 'return absent;')}`,
    ]) {
      writeFileSync(join(folder, 'bad.ts'), source);
      const result = await request('/capabilities', 'POST', {
        kind: 'tool',
        operation: 'register',
        modulePath: 'bad.ts',
      });
      expect([400, 409]).toContain(result.status);
    }
    await request('/capabilities', 'POST', { kind: 'tool', operation: 'disable', id: item.id });
    await expect(api.capabilities.invoke(item.id, { value: 'x' })).rejects.toThrow('disabled');
    await request('/capabilities', 'POST', { kind: 'tool', operation: 'remove', id: item.id });
    expect(api.capabilities.list('default')).toHaveLength(0);
  });
  it('terminates a synchronous loop, supports cancellation, and leaves the HTTP server responsive', async () => {
    const item = await register(
      'tool',
      toolSource('loop', 'while(true){}').replace('async execute', 'timeoutMs:150,async execute'),
    );
    const running = api.capabilities.invoke(item.id, { value: 'x' });
    expect((await request('/health')).status).toBe(200);
    await expect(running).rejects.toThrow('timed out');
    const controller = new AbortController();
    const stopped = api.capabilities.invoke(item.id, { value: 'x' }, 'execute', controller.signal);
    controller.abort();
    await expect(stopped).rejects.toThrow('cancelled');
    expect((await request('/health')).status).toBe(200);
  });
  it('preserves webhook raw bytes, enforces declared auth, and durably deduplicates background work', async () => {
    const processed = join(folder, 'processed.txt');
    const source = `import {createHmac,timingSafeEqual} from 'node:crypto';import {appendFileSync} from 'node:fs';
    export default {name:'payments',method:'POST',path:'/custom/payments',auth:'handler',requiredEnv:['HOOK_SECRET'],
      async handle(request,context){const signature=createHmac('sha256',context.env.HOOK_SECRET).update(request.rawBody).digest('hex');
        if(request.headers['x-signature']!==signature)return {status:401,body:{error:'Invalid signature'}};
        const result=await context.enqueue('payments',request.body.id,request.body);return {status:202,body:result};},
      async processJob(payload){appendFileSync(${JSON.stringify(processed)},payload.id+'\\n');}};`;
    const item = await register('route', source);
    await request('/environment', 'PUT', {
      entries: [{ name: 'HOOK_SECRET', value: 'hook-private-value' }],
    });
    const raw = '{ "id": "evt_123", "value": 10 }';
    const signature = createHmac('sha256', 'hook-private-value').update(raw).digest('hex');
    const send = (signature: string) =>
      fetch(api.url + '/custom/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body: raw,
      });
    expect((await send('bad')).status).toBe(401);
    const first = await send(signature);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ duplicate: false });
    expect(await (await send(signature)).json()).toMatchObject({ duplicate: true });
    await waitFor(
      () =>
        api.store.get("SELECT status FROM capability_jobs WHERE event_id='evt_123'")?.status ===
        'complete',
    );
    expect(readFileSync(processed, 'utf8')).toBe('evt_123\n');
    writeFileSync(
      join(folder, 'conflict.js'),
      source.replace("name:'payments'", "name:'collision'"),
    );
    expect(
      (
        await request('/capabilities', 'POST', {
          kind: 'route',
          operation: 'register',
          modulePath: 'conflict.js',
        })
      ).status,
    ).toBe(409);
    await request('/capabilities', 'POST', { kind: 'route', operation: 'disable', id: item.id });
    expect((await send(signature)).status).toBe(409);
    const auth = await register(
      'route',
      `export default {name:'private_route',method:'GET',path:'/custom/private',auth:'mukai',handle(){return {status:200,body:'private'}}};`,
      'private.js',
    );
    expect((await fetch(api.url + auth.definition.path)).status).toBe(401);
    expect(
      (
        await fetch(api.url + auth.definition.path, {
          headers: { Authorization: 'Bearer ' + api.token },
        })
      ).status,
    ).toBe(200);
  });
  it('recovers enabled registrations and pending jobs after restart using pinned versions', async () => {
    const processed = join(folder, 'recovered.txt');
    const source = `import {writeFileSync} from 'node:fs';export default {name:'recovery',method:'POST',path:'/custom/recovery',auth:'public',handle:async(r,c)=>({status:202,body:await c.enqueue('provider','event',{value:'old'})}),processJob:p=>writeFileSync(${JSON.stringify(processed)},p.value)};`;
    const item = await register('route', source, 'recovery.ts');
    expect((await fetch(api.url + '/custom/recovery', { method: 'POST' })).status).toBe(202);
    await request('/capabilities', 'POST', { kind: 'route', operation: 'disable', id: item.id });
    // Change export and handler: the queued job must still use its original version.
    writeFileSync(
      join(folder, 'recovery.ts'),
      source.replace('export default', 'export const replacement =').replace('p.value)', "'new')"),
    );
    expect(
      (
        await request('/capabilities', 'POST', {
          kind: 'route',
          operation: 'update',
          id: item.id,
          exportName: 'replacement',
        })
      ).status,
    ).toBe(200);
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    api = await startApiServer(0, { dataDir: join(root, 'data') });
    expect(api.capabilities.list('default')[0].status).toBe('disabled');
    await request('/capabilities', 'POST', { kind: 'route', operation: 'enable', id: item.id });
    await waitFor(
      () =>
        api.store.get("SELECT status FROM capability_jobs WHERE event_id='event'")?.status ===
        'complete',
    );
    expect(readFileSync(processed, 'utf8')).toBe('old');
    expect((await fetch(api.url + '/custom/recovery', { method: 'POST' })).status).toBe(202);
  });
  it('rejects invalid route responses and records useful failures', async () => {
    const item = await register(
      'route',
      `export default {name:'invalid_response',method:'GET',path:'/custom/invalid-response',auth:'public',handle:()=>({status:200,headers:{'content-length':'99'},body:'wrong'})};`,
      'invalid-response.js',
    );
    const response = await fetch(api.url + item.definition.path);
    expect(response.status).toBe(400);
    expect(api.capabilities.detail(item.id, 'default').runs[0]).toMatchObject({
      status: 'failed',
      error: 'Handler returned a reserved HTTP header.',
    });
  });
  it('bundles installed workspace dependencies and rejects imports outside the workspace', async () => {
    const dependency = join(folder, 'node_modules', 'capability-example');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'capability-example', main: 'index.js' }),
    );
    writeFileSync(join(dependency, 'index.js'), 'exports.suffix = "-package";');
    const item = await register(
      'tool',
      `import {suffix} from 'capability-example';${toolSource('package_tool', 'return {value:args.value+suffix};')}`,
      'package-tool.ts',
    );
    writeFileSync(join(dependency, 'index.js'), 'exports.suffix = "-changed";');
    expect(await api.capabilities.invoke(item.id, { value: 'original' })).toEqual({
      value: 'original-package',
    });
    writeFileSync(join(root, 'outside.js'), 'export const outside = "outside";');
    writeFileSync(
      join(folder, 'outside.ts'),
      `import {outside} from '../outside.js';${toolSource('outside', 'return outside;')}`,
    );
    expect(
      (
        await request('/capabilities', 'POST', {
          kind: 'tool',
          operation: 'register',
          modulePath: 'outside.ts',
        })
      ).status,
    ).toBe(400);
  });
  it('wakes only through an explicit helper and scopes wake-ups to the owner bot', async () => {
    const wakes: string[] = [];
    api.capabilities.setWake(async (botId, _workspaceId, message) => {
      wakes.push(botId + ':' + message);
    });
    const item = await register(
      'tool',
      toolSource('wake', `return await context.wakeBot('Process event');`),
      'wake.ts',
      'scout',
    );
    expect(wakes).toHaveLength(0);
    expect(await api.capabilities.invoke(item.id, { value: 'x' })).toEqual({ accepted: true });
    await waitFor(() => wakes.length === 1);
    expect(wakes).toEqual(['scout:Process event']);
  });
  it('registers with a suggested ID and calls the new tool in the same model conversation turn', async () => {
    writeFileSync(
      join(folder, 'weather-tool.js'),
      toolSource('immediate', `return {value:args.value+'-done'};`),
    );
    const schemas: string[][] = [];
    let steps = 0;
    fixture = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      schemas.push(
        (input.tools || []).map((item: { function: { name: string } }) => item.function.name),
      );
      const step = steps++;
      const delta =
        step < 2
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'custom-' + step,
                  type: 'function',
                  function: {
                    name: step === 0 ? 'register_custom_tool' : 'immediate',
                    arguments: JSON.stringify(
                      step === 0
                        ? {
                            operation: 'register',
                            id: 'weather',
                            modulePath: 'weather-tool.js',
                            exportName: 'default',
                          }
                        : { value: 'now' },
                    ),
                  },
                },
              ],
            }
          : { content: 'Custom tool finished.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'custom',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: step < 2 ? 'tool_calls' : 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    expect(
      (
        await request('/providers', 'POST', {
          name: 'Fixture',
          kind: 'compatible',
          baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
          defaultModel: 'fixture',
          supportsImages: false,
          isDefault: true,
          contextWindowTokens: 65536,
        })
      ).status,
    ).toBe(201);
    const response = await fetch(api.url + '/bots/scout/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: randomUUID(),
        text: 'Register immediate and call it.',
        attachmentIds: [],
      }),
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatEvent);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(schemas[0]).not.toContain('immediate');
    expect(schemas[1]).toContain('immediate');
    expect(api.store.all('SELECT status FROM capability_runs')).toEqual([{ status: 'complete' }]);
    const history = await request('/bots/scout/messages');
    expect(JSON.stringify(history.value)).toContain('Custom tool finished.');
  });
});
