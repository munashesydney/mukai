import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../config';
import { trustedLocalRequest } from './origin';
import { BrowserSession, matches } from './session';
import { send } from '../http/transport';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
type Route = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createWebHandler(
  directory: string,
  token: string,
  session: BrowserSession,
  route: Route,
) {
  const root = realpath(resolve(directory));
  // Startup validates the directory; retain any later I/O failure for the request boundary.
  void root.catch(() => {});
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/custom/')) return route(request, response);
    if (!trustedLocalRequest(request, true)) throw new ApiError(403, 'Untrusted request origin.');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/api/session') return session.handle(request, response);
    if (url.pathname === '/api/instance') {
      if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed');
      if (
        !session.authenticated(request) &&
        !matches(request.headers.authorization || '', `Bearer ${token}`)
      )
        throw new ApiError(401, 'API authentication required.');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      send(response, { instanceId: session.instanceId });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (session.authenticated(request)) request.headers.authorization = `Bearer ${token}`;
      request.url = url.pathname.slice(4) + url.search;
      return route(request, response);
    }
    if (url.pathname === '/health') return route(request, response);
    if (!['GET', 'HEAD'].includes(request.method || ''))
      throw new ApiError(405, 'Method not allowed');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new ApiError(400, 'Invalid path');
    }
    if (
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.split('/').some((part) => part === '..' || part.startsWith('.'))
    )
      throw new ApiError(404, 'Not found');
    const base = await root;
    const candidate = join(base, pathname === '/' ? 'index.html' : pathname);
    let file: string;
    try {
      file = await realpath(candidate);
    } catch {
      throw new ApiError(404, 'Not found');
    }
    const confined = relative(base, file);
    if (confined === '..' || confined.startsWith('..' + sep) || resolve(base, confined) !== file)
      throw new ApiError(404, 'Not found');
    const info = await stat(file);
    if (!info.isFile()) throw new ApiError(404, 'Not found');
    response.setHeader('Content-Type', contentTypes[extname(file)] || 'application/octet-stream');
    response.setHeader('Content-Length', info.size);
    response.setHeader(
      'Cache-Control',
      pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(file), response);
  };
}
