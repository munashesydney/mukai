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
export async function jsonBody(request: IncomingMessage) {
  try {
    return JSON.parse((await body(request)).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON request.');
  }
}
export function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status).end(JSON.stringify(value));
}

export function chatOutput(response: ServerResponse): ChatOutput {
  return {
    start() {
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
    },
    emit(event) {
      if (!response.destroyed) response.write(JSON.stringify(event) + '\n');
    },
    onDisconnect(callback) {
      const close = () => {
        if (!response.writableEnded) callback();
      };
      response.on('close', close);
      return () => response.off('close', close);
    },
    end() {
      response.end();
    },
  };
}
export function sendError(response: ServerResponse, error: unknown) {
  // Never serialize or log provider errors, request bodies, or credentials.
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
