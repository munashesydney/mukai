import { afterEach, describe, expect, it } from 'vitest';
import { startApiServer } from './app';
import type { Server } from 'node:http';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});
describe('Mukai API', () => {
  it('returns the health contract without exposing runtime internals', async () => {
    const api = await startApiServer();
    server = api.server;
    const response = await fetch(`${api.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'mukai-api',
      version: '0.1.0',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
  });
  it('rejects unsupported routes and methods', async () => {
    const api = await startApiServer();
    server = api.server;
    expect((await fetch(`${api.url}/missing`)).status).toBe(404);
    expect((await fetch(`${api.url}/health`, { method: 'POST' })).status).toBe(405);
    const response = await fetch(`${api.url}/health`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});
