import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';

// One backend answers two dialects: the Desktop renderer talks to it on its own
// origin with bare paths, while the browser build of the web UI talks to it on
// relative /api/... paths through the Vite proxy. Both have to reach the same
// routes without either client needing to know which UI started first.
let api: Awaited<ReturnType<typeof startApiServer>>, dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-path-alias-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
});

afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  expect(dir.startsWith(join(tmpdir(), 'mukai-path-alias-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, authorized = true) {
  const response = await fetch(api.url + path, {
    headers: authorized ? { Authorization: `Bearer ${api.token}` } : {},
  });
  return { status: response.status, body: await response.text() };
}

describe('the /api path alias', () => {
  it('routes an endpoint identically with and without the prefix', async () => {
    const bare = await get('/workspaces');
    const prefixed = await get('/api/workspaces');

    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(prefixed.body).toBe(bare.body);
  });

  it('keeps the public health route reachable in both dialects', async () => {
    expect((await get('/health', false)).status).toBe(200);
    expect((await get('/api/health', false)).status).toBe(200);
  });

  it('keeps requiring a token for prefixed paths', async () => {
    expect((await get('/api/workspaces', false)).status).toBe(401);
  });

  it('returns 404 for an unknown prefixed path', async () => {
    expect((await get('/api/definitely-not-a-route')).status).toBe(404);
  });

  it('does not strip a path that merely starts with the letters api', async () => {
    expect((await get('/apifoo')).status).toBe(404);
  });
});
