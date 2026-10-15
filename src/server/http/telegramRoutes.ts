import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError } from '../config';
import type { TelegramService } from '../services/telegramService';
import { jsonBody, send } from './transport';

const tokenSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/),
  })
  .strict();
const accessSchema = z
  .object({
    workspaces: z
      .array(
        z
          .object({
            workspaceId: z.string().min(1).max(40),
            botId: z.string().min(1).max(80).nullable(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

/** Called only after the shared local-origin and bearer-token checks. */
export async function telegramRoutes(
  service: TelegramService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
) {
  const method = request.method;
  if (path === '/telegram' && method === 'GET') return send(response, service.status());
  if (path === '/telegram/connect' && method === 'POST')
    return send(
      response,
      await service.connect(tokenSchema.parse(await jsonBody(request, 4096)).token),
    );
  if (path === '/telegram/pairing' && method === 'POST') return send(response, service.pairing());
  if (path === '/telegram/pairing/approve' && method === 'POST') {
    const input = z
      .object({ userId: z.number().int().positive().safe() })
      .strict()
      .parse(await jsonBody(request, 1024));
    return send(response, service.approve(input.userId));
  }
  if (path === '/telegram/access' && method === 'PUT')
    return send(
      response,
      await service.setAccess(accessSchema.parse(await jsonBody(request, 16384))),
    );
  if (path === '/telegram/state' && method === 'PUT') {
    const input = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await jsonBody(request, 1024));
    return send(response, await service.setEnabled(input.enabled));
  }
  if (path === '/telegram/connection' && method === 'DELETE')
    return send(response, await service.disconnect());
  if (path === '/telegram/owner' && method === 'DELETE')
    return send(response, await service.disconnect(true));
  throw new ApiError(404, 'Not found');
}
