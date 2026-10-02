import { createServer } from 'node:http';
import type { HealthResponse } from '../shared/contracts';

export function createApiServer() {
  const startedAt = Date.now();
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (request.url?.split('?')[0] === '/health') {
      const payload: HealthResponse = {
        status: 'ok',
        service: 'mukai-api',
        version: '0.1.0',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      };
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : JSON.stringify(payload));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  });
}

export async function startApiServer(port = 0) {
  const server = createApiServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind the Mukai API');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
