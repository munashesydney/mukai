import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { HealthResponse } from '../shared/contracts';
import { UPLOAD_LIMIT } from '../shared/ai';
import { Store, botDto, attachmentDto } from './database';
import { ApiError, defaultDataDir, privateSecret, acquireDataLock } from './config';
import { Providers } from './providers';
import { Attachments } from './attachments';
import { Chats } from './chat';

const botSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(400),
  instructions: z.string().trim().min(1).max(12000),
  providerId: z.string().uuid().nullable(),
  model: z.string().trim().min(1).max(150).nullable(),
  supportsImages: z.boolean().nullable(),
  avatar: z.enum(['scout', 'nova', 'atlas']),
});
async function body(request: IncomingMessage, limit = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Request exceeds the upload limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(request: IncomingMessage) {
  try {
    return JSON.parse((await body(request)).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON request.');
  }
}
function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status).end(JSON.stringify(value));
}
export interface ApiOptions {
  dataDir?: string;
  token?: string;
}
export function createApiServer(options: ApiOptions = {}) {
  const startedAt = Date.now();
  const dir = options.dataDir || defaultDataDir();
  const releaseLock = acquireDataLock(dir);
  let store: Store;
  try {
    store = new Store(dir);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const token = options.token || privateSecret(store.dir, 'api.token', 32).toString('hex');
  const providers = new Providers(store);
  const attachments = new Attachments(store);
  const chats = new Chats(store, providers, attachments);
  const route = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    const permittedOrigin =
      !origin || origin === 'null' || /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin);
    if (!permittedOrigin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || ''))
      throw new ApiError(403, 'Untrusted request origin.');
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Filename');
      response.writeHead(204).end();
      return;
    }
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const method = request.method || 'GET';
    if (path === '/health') {
      if (!['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new ApiError(405, 'Method not allowed');
      }
      const payload: HealthResponse = {
        status: 'ok',
        service: 'mukai-api',
        version: '0.1.0',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      };
      send(response, method === 'HEAD' ? undefined : payload);
      return;
    }
    if (!/^\/(bots|providers|attachments)(\/|$)/.test(path)) throw new ApiError(404, 'Not found');
    const given = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new ApiError(401, 'API authentication required.');
    const parts = path.split('/').filter(Boolean);
    const [resource, id, action] = parts;
    if (parts.length > 3) throw new ApiError(404, 'Not found');
    if (resource === 'providers') {
      if (!id && method === 'GET') return send(response, store.providers());
      if (!id && method === 'POST')
        return send(response, providers.save(await jsonBody(request)), 201);
      if (id && method === 'PUT' && !action) {
        if (!store.get('SELECT id FROM providers WHERE id = ?', id))
          throw new ApiError(404, 'Provider not found.');
        return send(response, providers.save(await jsonBody(request), id));
      }
      if (id && method === 'DELETE' && !action) {
        providers.remove(id);
        return send(response, { ok: true });
      }
      if (id && action === 'test' && method === 'POST')
        return send(response, await providers.test(id));
    } else if (resource === 'bots') {
      if (!id && method === 'GET') return send(response, store.bots());
      if (!id && method === 'POST') {
        const value = botSchema.parse(await jsonBody(request));
        if (
          value.providerId &&
          !store.get('SELECT id FROM providers WHERE id = ?', value.providerId)
        )
          throw new ApiError(400, 'Provider not found.');
        const newId = store.id();
        store.run(
          'INSERT INTO bots VALUES (?,?,?,?,?,?,?,?,?)',
          newId,
          value.name,
          value.description,
          value.instructions,
          value.providerId,
          value.model,
          value.supportsImages === null ? null : Number(value.supportsImages),
          value.avatar,
          new Date().toISOString(),
        );
        return send(response, botDto(store.get('SELECT * FROM bots WHERE id = ?', newId)!), 201);
      }
      const bot = store.get('SELECT * FROM bots WHERE id = ?', id || '');
      if (!bot) throw new ApiError(404, 'Bot not found.');
      if (method === 'PUT' && !action) {
        if (chats.busy(id)) throw new ApiError(409, 'Stop this bot’s response before editing it.');
        const value = botSchema.parse(await jsonBody(request));
        if (
          value.providerId &&
          !store.get('SELECT id FROM providers WHERE id = ?', value.providerId)
        )
          throw new ApiError(400, 'Provider not found.');
        store.run(
          'UPDATE bots SET name=?,description=?,instructions=?,provider_id=?,model=?,supports_images=?,avatar=? WHERE id=?',
          value.name,
          value.description,
          value.instructions,
          value.providerId,
          value.model,
          value.supportsImages === null ? null : Number(value.supportsImages),
          value.avatar,
          id,
        );
        return send(response, botDto(store.get('SELECT * FROM bots WHERE id = ?', id)!));
      }
      if (method === 'DELETE' && !action) {
        if (chats.busy(id)) throw new ApiError(409, 'Stop this bot’s response before deleting it.');
        const files = store.all('SELECT storage_name FROM attachments WHERE bot_id = ?', id);
        store.run('DELETE FROM bots WHERE id = ?', id);
        files.forEach((file) => attachments.removeFile(String(file.storage_name)));
        return send(response, { ok: true });
      }
      if (action === 'messages' && method === 'GET') return send(response, chats.history(id));
      if (action === 'files' && method === 'GET')
        return send(
          response,
          store
            .all('SELECT * FROM attachments WHERE bot_id = ? AND message_id IS NOT NULL', id)
            .map(attachmentDto),
        );
      if (action === 'attachments' && method === 'GET')
        return send(
          response,
          store
            .all('SELECT * FROM attachments WHERE bot_id = ? AND message_id IS NULL', id)
            .map(attachmentDto),
        );
      if (action === 'attachments' && method === 'POST') {
        let filename: string;
        try {
          filename = decodeURIComponent(String(request.headers['x-filename'] || ''));
        } catch {
          throw new ApiError(400, 'Invalid filename.');
        }
        return send(
          response,
          await attachments.upload(id, filename, await body(request, UPLOAD_LIMIT)),
          201,
        );
      }
      if (action === 'chat' && method === 'POST')
        return chats.respond(bot, await jsonBody(request), response);
      if (action === 'stop' && method === 'POST') {
        chats.stop(id);
        return send(response, { ok: true });
      }
    } else if (resource === 'attachments' && id && !action) {
      if (method === 'DELETE') {
        attachments.remove(id);
        return send(response, { ok: true });
      }
      if (method === 'GET') {
        const { row, bytes } = attachments.read(id);
        response.setHeader('Content-Type', String(row.media_type));
        response.setHeader(
          'Content-Disposition',
          `${row.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(String(row.name))}`,
        );
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.writeHead(200).end(bytes);
        return;
      }
    }
    throw new ApiError(405, 'Method not allowed.');
  };
  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      // Never serialize or log provider errors, request bodies, or credentials.
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof z.ZodError)
        send(
          response,
          { error: 'Invalid settings. Check required fields and length limits.' },
          400,
        );
      else
        send(
          response,
          {
            error:
              error instanceof ApiError
                ? error.message
                : 'The server could not complete this request.',
          },
          error instanceof ApiError ? error.status : 500,
        );
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let closed = false;
  const dispose = () => {
    if (!closed) {
      closed = true;
      store.db.close();
      releaseLock();
    }
  };
  server.on('close', () => {
    void chats.shutdown().finally(dispose);
  });
  return { server, token, store, shutdown: () => chats.shutdown(), dispose };
}
export async function startApiServer(port = 0, options: ApiOptions = {}) {
  const api = createApiServer(options);
  try {
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject);
      api.server.listen(port, '127.0.0.1', () => {
        api.server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    api.dispose();
    throw error;
  }
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind the Mukai API');
  return { ...api, url: `http://127.0.0.1:${address.port}` };
}
