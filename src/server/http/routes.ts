import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HealthResponse } from '../../shared/contracts';
import { UPLOAD_LIMIT } from '../../shared/ai';
import { ApiError } from '../config';
import type { BotService } from '../services/botService';
import type { ProviderService } from '../services/providerService';
import type { AttachmentService } from '../services/attachmentService';
import type { ChatService } from '../services/chatService';
import {
  botSchema,
  createBotSchema,
  providerSchema,
  chatSchema,
  workspaceSchema,
  spaceSchema,
  spaceChatSchema,
  savedMessageSchema,
  spaceImportSchema,
} from './schemas';
import type { WorkspaceService } from '../services/workspaceService';
import type { ArtifactService } from '../services/artifactService';
import type { ToolService } from '../services/toolService';
import { body, jsonBody, send, chatOutput } from './transport';
import type { FileChangeService } from '../services/fileChangeService';
import type { ConversationService } from '../services/conversationService';
import type { PursuitService } from '../services/pursuitService';
import { z } from 'zod';
import type { BrowserService } from '../services/browserService';
import { browserDefinition } from '../tools/browser/definition';

function uploadName(request: IncomingMessage) {
  try {
    return decodeURIComponent(String(request.headers['x-filename'] || ''));
  } catch {
    throw new ApiError(400, 'Invalid filename.');
  }
}

export function createRoutes({
  token,
  startedAt,
  bots,
  providers,
  attachments,
  chats,
  workspaces,
  artifacts,
  tools,
  changes,
  conversations,
  pursuits,
  browsers,
}: {
  token: string;
  startedAt: number;
  bots: BotService;
  providers: ProviderService;
  attachments: AttachmentService;
  chats: ChatService;
  workspaces: WorkspaceService;
  artifacts: ArtifactService;
  tools: ToolService;
  changes: FileChangeService;
  conversations: ConversationService;
  pursuits: PursuitService;
  browsers: BrowserService;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
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
    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname;
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
    if (
      !/^\/(bots|providers|attachments|workspaces|artifacts|tools|changes|conversations|pursuits|browser)(\/|$)/.test(
        path,
      )
    )
      throw new ApiError(404, 'Not found');
    const given = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new ApiError(401, 'API authentication required.');
    const parts = path.split('/').filter(Boolean);
    const [resource, id, action] = parts;
    if (parts.length > 3) throw new ApiError(404, 'Not found');
    if (resource === 'browser') {
      if (!id && method === 'GET') {
        const workspaceId = url.searchParams.get('workspaceId') || 'default';
        workspaces.require(workspaceId);
        return send(response, await browsers.refresh(workspaceId));
      }
      if (id && action === 'screenshot' && method === 'GET') {
        response.setHeader('Content-Type', 'image/png');
        response.writeHead(200).end(browsers.screenshot(id));
        return;
      }
      if (id && action === 'control' && method === 'POST') {
        const input = browserDefinition.inputSchema.parse(await jsonBody(request));
        if (['open', 'tabs'].includes(input.action))
          throw new ApiError(400, 'Use an existing tab action.');
        return send(response, await browsers.control(id, input));
      }
    } else if (resource === 'pursuits') {
      if (!id && method === 'GET')
        return send(response, pursuits.list(url.searchParams.get('workspaceId') || 'default'));
      if (id && !action && method === 'GET') return send(response, pursuits.detail(id));
      if (id && action === 'status' && method === 'PUT') {
        const input = z
          .object({ status: z.enum(['paused', 'active']) })
          .parse(await jsonBody(request));
        return send(response, pursuits.control(id, input.status));
      }
      if (id && action === 'run' && method === 'POST')
        return send(response, pursuits.runNow(id), 201);
    } else if (resource === 'conversations') {
      if (!id && method === 'GET') {
        const workspaceId = url.searchParams.get('workspaceId') || 'default';
        return send(
          response,
          url.searchParams.get('kind') === 'private'
            ? conversations.privateChats(workspaceId)
            : conversations.list(workspaceId),
        );
      }
      if (!id && method === 'POST') {
        const input = spaceSchema.parse(await jsonBody(request));
        return send(response, conversations.create(input.workspaceId, input), 201);
      }
      if (id === 'import' && !action && method === 'POST') {
        const input = spaceImportSchema.parse(await jsonBody(request, 2 * 1024 * 1024));
        return send(response, conversations.import(input.workspaceId, input.spaces));
      }
      if (id) {
        const conversation = conversations.require(id);
        if (action === 'messages' && method === 'GET')
          return send(response, conversations.history(id));
        if (action === 'chat' && method === 'POST') {
          if (conversation.kind === 'private')
            return conversations.sendPrivate(
              id,
              chatSchema.parse(await jsonBody(request)),
              chatOutput(response),
            );
          return conversations.send(
            id,
            spaceChatSchema.parse(await jsonBody(request)),
            chatOutput(response),
          );
        }
        if (action === 'attachments' && method === 'GET') {
          conversations.privateBot(id);
          return send(response, attachments.pending(id));
        }
        if (action === 'attachments' && method === 'POST') {
          const bot = conversations.privateBot(id);
          return send(
            response,
            await attachments.upload(
              bot.id,
              uploadName(request),
              await body(request, UPLOAD_LIMIT),
              id,
            ),
            201,
          );
        }
        if (action === 'saved' && method === 'PUT') {
          const input = savedMessageSchema.parse(await jsonBody(request));
          return send(response, conversations.save(id, input.messageId, input.saved));
        }
        if (action === 'artifacts' && method === 'GET')
          return send(response, artifacts.forConversation(id));
        if (action === 'stop' && method === 'POST') {
          conversations.stop(id);
          return send(response, { ok: true });
        }
      }
    } else if (resource === 'changes' && id && !action && method === 'GET') {
      return send(response, changes.detail(id));
    } else if (resource === 'workspaces') {
      if (!id && method === 'GET') return send(response, workspaces.list());
      if (!id && method === 'POST')
        return send(
          response,
          workspaces.create(workspaceSchema.parse(await jsonBody(request))),
          201,
        );
      if (id && !action && method === 'PUT')
        return send(
          response,
          workspaces.update(id, workspaceSchema.parse(await jsonBody(request))),
        );
    } else if (resource === 'tools' && !id && method === 'GET') {
      return send(response, tools.list(url.searchParams.get('workspaceId') || 'default'));
    } else if (resource === 'artifacts' && id && !action && method === 'GET') {
      const file = await artifacts.read(id);
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      response.writeHead(200).end(file.bytes);
      return;
    } else if (resource === 'providers') {
      if (!id && method === 'GET') return send(response, providers.list());
      if (!id && method === 'POST')
        return send(response, providers.save(providerSchema.parse(await jsonBody(request))), 201);
      if (id && method === 'PUT' && !action) {
        return send(response, providers.save(providerSchema.parse(await jsonBody(request)), id));
      }
      if (id && method === 'DELETE' && !action) {
        providers.remove(id);
        return send(response, { ok: true });
      }
      if (id && action === 'test' && method === 'POST')
        return send(response, await providers.test(id));
    } else if (resource === 'bots') {
      if (!id && method === 'GET')
        return send(response, bots.list(url.searchParams.get('workspaceId') || 'default'));
      if (!id && method === 'POST') {
        const value = createBotSchema.parse(await jsonBody(request));
        return send(response, bots.save(value, undefined, value.workspaceId), 201);
      }
      const bot = bots.require(id || '');
      if (action === 'conversations' && method === 'POST')
        return send(response, conversations.createPrivate(bot.id), 201);
      if (method === 'PUT' && !action)
        return send(response, bots.save(botSchema.parse(await jsonBody(request)), id));
      if (method === 'DELETE' && !action) {
        bots.remove(id);
        return send(response, { ok: true });
      }
      if (action === 'messages' && method === 'GET') return send(response, chats.history(id));
      if (action === 'files' && method === 'GET')
        return send(response, attachments.list(id, false));
      if (action === 'artifacts' && method === 'GET') return send(response, artifacts.list(id));
      if (action === 'attachments' && method === 'GET')
        return send(response, attachments.list(id, true));
      if (action === 'attachments' && method === 'POST') {
        return send(
          response,
          await attachments.upload(id, uploadName(request), await body(request, UPLOAD_LIMIT)),
          201,
        );
      }
      if (action === 'chat' && method === 'POST')
        return chats.respond(bot, chatSchema.parse(await jsonBody(request)), chatOutput(response));
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
        response.setHeader('Content-Type', String(row.mediaType));
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
}
