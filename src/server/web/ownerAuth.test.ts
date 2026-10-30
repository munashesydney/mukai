import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { startApiServer } from '../app';
import { authReset } from '../../cli/commands/authReset';

let root: string;
let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
let webDir: string;
const login = { username: 'owner', password: 'a long owner passphrase' };
it('accepts an email username and a 10-character password, and explains invalid fields', async () => {
  const proof = await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode });
  const emailLogin = { username: 'owner+personal@example.com', password: '1234567890' };
  const shortPassword = await call(
    '/api/auth/setup',
    { ...emailLogin, password: '123456789' },
    proof.cookie,
  );
  expect(shortPassword.status).toBe(400);
  expect(shortPassword.body.error).toBe('Password must be at least 10 characters.');
  const invalidUsername = await call(
    '/api/auth/setup',
    { ...emailLogin, username: 'has spaces' },
    proof.cookie,
  );
  expect(invalidUsername.status).toBe(400);
  expect(invalidUsername.body.error).toBe('Username cannot contain spaces or control characters.');
  expect((await call('/api/auth/setup', emailLogin, proof.cookie)).status).toBe(200);
  expect((await call('/api/auth/login', emailLogin)).status).toBe(200);
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mukai-owner-'));
  webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<html>Mukai</html>');
  api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
});
async function close() {
  if (api) {
    await api.shutdown();
    await new Promise<void>((resolve) => api!.server.close(() => resolve()));
    api = undefined;
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await rm(root, { recursive: true, force: true });
});
async function call(
  path: string,
  value?: unknown,
  cookie = '',
  host = 'mukai.example',
  origin = 'https://mukai.example',
) {
  return new Promise<{
    status: number;
    cookie: string;
    setCookie: string;
    body: Record<string, unknown>;
  }>((resolve, reject) => {
    const probe = httpRequest(
      api!.url + path,
      {
        method: value === undefined ? 'GET' : 'POST',
        headers: { Host: host, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const setCookie = response.headers['set-cookie']?.[0] || '';
          resolve({
            status: response.statusCode!,
            cookie: setCookie.split(';')[0],
            setCookie,
            body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          });
        });
      },
    );
    probe.once('error', reject);
    probe.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
async function setup() {
  const proof = await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode });
  expect(proof.status).toBe(200);
  return call('/api/auth/setup', login, proof.cookie);
}
it('requires ownership proof, atomically claims one owner, and stores only hashes', async () => {
  expect((await call('/api/auth/status')).body).toEqual({
    configured: false,
    authenticated: false,
    verified: false,
  });
  expect((await call('/api/auth/setup', login)).status).toBe(401);
  expect(
    (
      await call(
        '/api/auth/verify',
        { code: api!.ownerAuth!.setupCode },
        '',
        'mukai.example',
        'http://mukai.example',
      )
    ).status,
  ).toBe(403);
  expect((await call('/api/auth/verify', { code: 'wrong' })).status).toBe(401);
  const first = await call('/api/auth/verify', {
    code: api!.ownerAuth!.setupCode.toUpperCase().match(/.{8}/g)!.join('-'),
  });
  const second = await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode });
  expect(
    (await call('/api/auth/setup', { ...login, password: 'short' }, first.cookie)).status,
  ).toBe(400);
  const claims = await Promise.all([
    call('/api/auth/setup', login, first.cookie),
    call('/api/auth/setup', { ...login, username: 'other-owner' }, second.cookie),
  ]);
  expect(claims.map((value) => value.status).sort()).toEqual([200, 409]);
  expect((await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode })).status).toBe(409);
  const owner = api!.store.get('SELECT * FROM web_owner')!;
  expect(owner.password_hash).not.toBe(login.password);
  expect(String(owner.password_hash)).toHaveLength(128);
  expect(String(owner.salt)).toHaveLength(32);
  const session = claims.find((value) => value.status === 200)!;
  expect(session.setCookie).toContain('HttpOnly');
  expect(session.setCookie).toContain('SameSite=Strict');
  expect(session.setCookie).toContain('Secure');
  expect(api!.store.get('SELECT token_hash FROM web_sessions')!.token_hash).not.toBe(
    session.cookie.split('=')[1],
  );
});
it('protects APIs, rejects cross-origin and public bearer/bootstrap access, persists login and revokes logout', async () => {
  const session = await setup();
  expect(session.status).toBe(200);
  expect((await call('/api/workspaces')).status).toBe(401);
  expect((await call('/api/workspaces', undefined, session.cookie)).status).toBe(200);
  expect(
    (
      await call(
        '/api/workspaces',
        undefined,
        session.cookie,
        'mukai.example',
        'https://evil.example',
      )
    ).status,
  ).toBe(403);
  expect((await call('/api/session', { token: api!.browserSession!.connectToken })).status).toBe(
    401,
  );
  const bearer = await new Promise<number>((resolve) => {
    const request = httpRequest(
      api!.url + '/api/workspaces',
      { headers: { Host: 'mukai.example', Authorization: 'Bearer ' + api!.token } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.end();
  });
  expect(bearer).toBe(401);
  for (const origin of ['null', 'file://']) {
    expect(
      (
        await fetch(api!.url + '/api/workspaces', {
          headers: { Origin: origin, Authorization: 'Bearer ' + api!.token },
        })
      ).status,
    ).toBe(200);
  }
  expect((await call('/api/auth/login', { ...login, password: 'wrong' })).status).toBe(401);
  const another = await call('/api/auth/login', login);
  expect(another.status).toBe(200);
  expect(another.cookie).not.toBe(session.cookie);
  await close();
  api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
  expect((await call('/api/auth/status', undefined, session.cookie)).body.authenticated).toBe(true);
  expect((await call('/api/auth/logout', {}, session.cookie)).status).toBe(200);
  expect((await call('/api/workspaces', undefined, session.cookie)).status).toBe(401);
  expect((await call('/api/workspaces', undefined, another.cookie)).status).toBe(200);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86400_000);
  expect((await call('/api/workspaces', undefined, another.cookie)).status).toBe(401);
  clock.mockRestore();
});
it('expires proofs and setup codes, throttles guesses and resets credentials only while offline', async () => {
  const proof = await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  expect((await call('/api/auth/setup', login, proof.cookie)).status).toBe(401);
  expect((await call('/api/auth/verify', { code: api!.ownerAuth!.setupCode })).status).toBe(401);
  clock.mockRestore();
  for (let i = 0; i < 10; i++) await call('/api/auth/verify', { code: 'wrong' });
  expect((await call('/api/auth/verify', { code: 'wrong' })).status).toBe(429);
  expect(() => authReset(join(root, 'data'))).toThrow('Another Mukai backend');
  await close();
  api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
  await setup();
  api!.store.run('INSERT INTO app_settings(key,value) VALUES(?,?)', 'auth-smoke', 'preserved');
  await close();
  expect(authReset(join(root, 'data'))).toBe(0);
  api = await startApiServer(0, { dataDir: join(root, 'data'), webDir });
  expect(api.ownerAuth!.configured()).toBe(false);
  expect(api.store.get('SELECT value FROM app_settings WHERE key=?', 'auth-smoke')!.value).toBe(
    'preserved',
  );
});
