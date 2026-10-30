import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from '../app';
import { seedTestWorkspace } from '../testFixtures';
import type { CapabilityRegistration } from '../../shared/customCapabilities';
let api: Awaited<ReturnType<typeof startApiServer>>, root: string, folder: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-redaction-'));
  folder = join(root, 'workspace');
  mkdirSync(folder);
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  seedTestWorkspace(api.store);
  api.workspaces.update('default', { name: 'Redaction test', folder });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function register(
  body: unknown,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
) {
  writeFileSync(
    join(folder, 'route.ts'),
    `export default {name:'redaction_probe',method:'GET',path:'/custom/redaction-probe',auth:'public',handle(){return {status:200,headers:${JSON.stringify(headers)},body:${JSON.stringify(body)}};}}`,
  );
  return (await api.capabilities.manage('default', null, 'route', {
    operation: 'register',
    modulePath: 'route.ts',
  })) as CapabilityRegistration;
}
const get = () => fetch(api.url + '/custom/redaction-probe');
it('preserves JSON-string responses and reports redaction in HTTP, internal calls, and payload-free diagnostics', async () => {
  api.capabilities.environment.save('default', [
    { name: 'IMAP_PORT', value: '993' },
    { name: 'PASSWORD', value: 'dummy-private-password' },
  ]);
  const raw =
    '{ "port":993, "id":900719925474099312345, "password":"dummy-private-password", "nested":[993] }';
  const route = await register(raw, {
    'Content-Type': 'application/problem+json',
    'X-Note': 'port 993',
  });
  const result = await get();
  expect(result.status).toBe(200);
  expect(result.headers.get('x-mukai-redacted')).toBe('4');
  const wire = await result.text();
  expect(wire).toContain('900719925474099312345');
  expect(JSON.parse(wire)).toMatchObject({
    port: '[redacted]',
    password: '[redacted]',
    nested: ['[redacted]'],
  });
  const internal = (await api.capabilities.invoke(
    route.id,
    { headers: {}, rawBody: Buffer.alloc(0) },
    'handle',
  )) as { headers: Record<string, string>; body: string };
  expect(internal.headers['x-mukai-redacted']).toBe('4');
  expect(() => JSON.parse(internal.body)).not.toThrow();
  const log = readFileSync(join(root, 'data/logs/errors.log'), 'utf8');
  const event = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((row) => row.event === 'capability.response_redacted');
  expect(event).toMatchObject({ capabilityId: route.id, redactionCount: 4 });
  expect(log).not.toContain('dummy-private-password');
  expect(log).not.toContain('900719925474099312345');
});
it('lets owners declassify ports immediately, preserves that setting on value edits, and keeps shared secret values protected', async () => {
  api.capabilities.environment.save('default', [{ name: 'IMAP_PORT', value: '993' }]);
  const route = await register({ port: 993, host: 'host:993' });
  expect(await (await get()).json()).toEqual({ port: '[redacted]', host: 'host:[redacted]' });
  const auth = { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' };
  const change = await fetch(api.url + '/environment/IMAP_PORT', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ secret: false }),
  });
  expect(change.status).toBe(200);
  expect(await change.json()).toContainEqual(
    expect.objectContaining({ name: 'IMAP_PORT', secret: false, configured: true }),
  );
  const visible = await get();
  expect(visible.headers.get('x-mukai-redacted')).toBeNull();
  expect(await visible.json()).toEqual({ port: 993, host: 'host:993' });
  api.capabilities.environment.resolve('default', ['IMAP_PORT']);
  api.capabilities.environment.export('default');
  expect(api.capabilities.environment.redact('993')).toBe('993');
  api.capabilities.environment.save('default', [{ name: 'IMAP_PORT', value: '994' }]);
  expect(api.capabilities.environment.list('default')[0].secret).toBe(false);
  const another = api.workspaces.create({ name: 'Other', folder: tmpdir() });
  api.capabilities.environment.save(another.id, [{ name: 'PRIVATE_PIN', value: '993' }]);
  expect(await (await get()).json()).toEqual({ port: '[redacted]', host: 'host:[redacted]' });
  expect(api.capabilities.detail(route.id, 'default').registration.status).toBe('ready');
});
it('retains rotated and deleted secrets, skips empty/config values, and restores classifications on restart', async () => {
  const env = api.capabilities.environment;
  env.save('default', [
    { name: 'KEY', value: 'old-secret-value' },
    { name: 'PORT', value: '993', secret: false },
    { name: 'EMPTY', value: '' },
  ]);
  env.save('default', [{ name: 'KEY', value: 'new-secret-value' }]);
  env.remove('default', 'KEY');
  expect(env.redact('old-secret-value/new-secret-value/993')).toBe('[redacted]/[redacted]/993');
  const { CapabilityEnvironment } = await import('./environment');
  const restored = new CapabilityEnvironment(api.store);
  expect(restored.redact('993')).toBe('993');
  expect(restored.list('default').find((v) => v.name === 'PORT')?.secret).toBe(false);
  expect(
    (
      await fetch(api.url + '/environment/PORT', {
        method: 'PATCH',
        body: '{"secret":true}',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
  ).toBe(401);
});
it('rejects malformed declared JSON with a failed run instead of sending HTTP 200 garbage', async () => {
  api.capabilities.environment.save('default', [{ name: 'KEY', value: 'private-value' }]);
  const route = await register('{"password":"private-value", bad}');
  const response = await get();
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('private-value');
  expect(api.capabilities.detail(route.id, 'default').runs[0].status).toBe('failed');
});
it('does not let handlers spoof the redaction notice and permits forwarding already-redacted routes', async () => {
  const inner = await register({ port: 993 }, { 'X-Mukai-Redacted': '999' });
  expect((await get()).headers.get('x-mukai-redacted')).toBeNull();
  api.capabilities.environment.save('default', [{ name: 'PRIVATE_PIN', value: '993' }]);
  writeFileSync(
    join(folder, 'forward.ts'),
    `export default {name:'redaction_forward',method:'GET',path:'/custom/redaction-forward',auth:'public',async handle(request,context){return context.callRoute(${JSON.stringify(inner.id)});}}`,
  );
  await api.capabilities.manage('default', null, 'route', {
    operation: 'register',
    modulePath: 'forward.ts',
  });
  const response = await fetch(api.url + '/custom/redaction-forward');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-mukai-redacted')).toBe('1');
  expect(await response.json()).toEqual({ port: '[redacted]' });
});
it('masks escaped and multiline credentials through an actual JSON HTTP response', async () => {
  const password = 'dummy "quoted"\n\\credential';
  api.capabilities.environment.save('default', [{ name: 'PASSWORD', value: password }]);
  await register(JSON.stringify({ password, ok: true }));
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-mukai-redacted')).toBe('1');
  const text = await response.text();
  expect(text).not.toContain('credential');
  expect(JSON.parse(text)).toEqual({ password: '[redacted]', ok: true });
});
