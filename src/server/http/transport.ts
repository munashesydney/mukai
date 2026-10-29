import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ChatOutput } from '../services/chatService';
import { ApiError } from '../config';
import { z } from 'zod';

export async function body(request: IncomingMessage, limit = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Request exceeds the upload limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(request: IncomingMessage, limit?: number) {
  try {
    return JSON.parse((await body(request, limit)).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON request.');
  }
}
export function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status).end(JSON.stringify(value));
}

/** Below this size the framing and CPU cost outweighs what compression can save. */
const COMPRESS_FROM = 1024;

/** Weak validators stay valid for the compressed variant an intermediary may swap in. */
function fingerprint(payload: Buffer): string {
  return `W/"${createHash('sha1').update(payload).digest('base64url')}"`;
}

function validator(value: string): string {
  return value.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
}

function notModified(request: IncomingMessage, etag: string): boolean {
  const header = request.headers['if-none-match'];
  const candidates = (Array.isArray(header) ? header.join(',') : header || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  // An empty If-None-Match header from an intermediary must never read as a match.
  return candidates.includes('*')
    ? candidates.length === 1
    : candidates.some((item) => validator(item) === validator(etag));
}

function acceptsGzip(request: IncomingMessage): boolean {
  const header = request.headers['accept-encoding'];
  return (Array.isArray(header) ? header.join(',') : header || '')
    .split(',')
    .some((item) => /^\s*gzip\s*(;|$)/i.test(item));
}

/** Keeps the CORS `Vary: Origin` set by the handler while adding our own dimension. */
function vary(response: ServerResponse, addition: string): string {
  const existing = response.getHeader('Vary');
  const tokens = (Array.isArray(existing) ? existing.join(',') : typeof existing === 'string' ? existing : '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(addition);
  return [...new Map(tokens.map((item) => [item.toLowerCase(), item])).values()].join(', ');
}

/**
 * Answers a polled read conditionally and compressed.
 *
 * The UI re-reads the same handful of endpoints every second, and one long
 * conversation's history is megabytes, so re-sending unchanged bodies is what
 * filled the tunnel and stalled the renderer. A digest of the serialized
 * payload makes an unchanged read a body-less 304, and gzip keeps the changed
 * ones small on the local link, where no edge compressor sits in front.
 *
 * `send` stays as-is for writes: only reads revalidate.
 */
export function sendRead(
  request: IncomingMessage,
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  const serialized = JSON.stringify(value);
  const payload = Buffer.from(serialized === undefined ? '' : serialized, 'utf8');
  const etag = fingerprint(payload);
  const varyHeaders = { ETag: etag, Vary: vary(response, 'Accept-Encoding') };
  if (notModified(request, etag)) {
    // Node omits the body (and length framing) for a 304 on its own.
    response.writeHead(304, varyHeaders).end();
    return;
  }
  if (request.method === 'HEAD') {
    response.writeHead(status, { ...varyHeaders, 'Content-Length': String(payload.length) }).end();
    return;
  }
  if (payload.length >= COMPRESS_FROM && acceptsGzip(request)) {
    const compressed = gzipSync(payload, { level: 1 });
    if (compressed.length < payload.length) {
      response.writeHead(status, {
        ...varyHeaders,
        'Content-Encoding': 'gzip',
        'Content-Length': String(compressed.length),
      });
      response.end(compressed);
      return;
    }
  }
  response.writeHead(status, { ...varyHeaders, 'Content-Length': String(payload.length) });
  response.end(payload);
}


function wantsEventStream(request?: IncomingMessage): boolean {
  const accept = request?.headers?.accept;
  if (!accept) return false;
  return /text\/event-stream/i.test(Array.isArray(accept) ? accept.join(',') : accept);
}

export function chatOutput(response: ServerResponse, request?: IncomingMessage): ChatOutput {
  let ended = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stopKeepalive = (): void => {
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
  };
  // Negotiated per request. Only text/event-stream reliably crosses
  // intermediaries unbuffered, so a browser that asks for it is streamed live;
  // clients that read newline-delimited JSON keep the frame they can parse.
  const sse = wantsEventStream(request);
  return {
    start() {
      if (ended) return;
      response.writeHead(200, sse
        ? {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          }
        : {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'X-Accel-Buffering': 'no',
          });
      response.flushHeaders();
      if (!sse) return;
      // Proxies release held bytes only once something arrives, so an idle
      // generation (long tool call, approval wait) needs the channel kept open.
      keepalive = setInterval(() => {
        if (ended || response.destroyed || response.writableEnded) return stopKeepalive();
        response.write(': keepalive\n\n');
      }, 4_000);
      keepalive.unref();
    },
    emit(event) {
      if (ended || response.destroyed || response.writableEnded) return;
      // Payloads are single-line JSON, so one event per write needs no
      // continuation framing in either shape.
      const payload = JSON.stringify(event);
      response.write(sse ? `data: ${payload}\n\n` : `${payload}\n`);
    },
    onDisconnect(callback) {
      const close = () => {
        stopKeepalive();
        if (!response.writableEnded) callback();
      };
      response.on('close', close);
      return () => response.off('close', close);
    },
    end() {
      if (ended) return;
      ended = true;
      stopKeepalive();
      if (!response.writableEnded) response.end();
    },
  };
}
export function sendError(response: ServerResponse, error: unknown) {
  // Never serialize raw provider errors, request bodies, or credentials to the UI.
  // The server boundary records separately filtered diagnostics.
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof z.ZodError)
    send(response, { error: 'Invalid settings. Check required fields and length limits.' }, 400);
  else
    send(
      response,
      {
        error:
          error instanceof ApiError ? error.message : 'The server could not complete this request.',
      },
      error instanceof ApiError ? error.status : 500,
    );
}
