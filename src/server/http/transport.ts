import type { IncomingMessage, ServerResponse } from 'node:http';
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
