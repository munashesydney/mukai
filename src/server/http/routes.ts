import type { SkillService } from '../skills/service';
import { bundleSchema } from '../skills/bundle';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HealthResponse } from '../../shared/contracts';
import { UPLOAD_LIMIT } from '../../shared/ai';
import { ApiError } from '../config';
import type { BotService } from '../services/botService';
import type { ProviderService } from '../services/providerService';
import type { AttachmentService } from '../services/attachmentService';
import type { ChatService } from '../services/chatService';
import type { ApprovalService } from '../services/approvalService';
import {
  botSchema,
  botModelSchema,
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
import type { CapabilityService } from '../capabilities/service';
import { registrationInput } from '../capabilities/service';
import { memorySettingsSchema, type MemoryService } from '../services/memoryService';

function uploadName(request: IncomingMessage) {
  try {
    return decodeURIComponent(String(request.headers['x-filename'] || ''));
  } catch {
    throw new ApiError(400, 'Invalid filename.');
  }
}

export function createRoutes({
  approvals,
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
  capabilities,
  memory,
  skills,
}: {
  approvals: ApprovalService;
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
  capabilities: CapabilityService;
  memory: MemoryService;
  skills: SkillService;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Custom ingress applies its own host/auth policy; management APIs retain local auth.
    if (new URL(request.url || '/', 'http://localhost').pathname.startsWith('/custom/')) {
      return capabilities.dispatch(request, response, token);
    }
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
      !/^\/(approvals|bots|providers|attachments|workspaces|artifacts|tools|changes|conversations|pursuits|browser|capabilities|environment|memory|skills)(\/|$)/.test(
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
    if (resource === 'approvals') {
      if (!id && method === 'GET') return send(response, approvals.state());
      if (!id && method === 'PUT') {
        const input = z
          .object({ mode: z.enum(['ask-for-approval', 'full-access']) })
          .strict()
          .parse(await jsonBody(request));
        return send(response, approvals.setMode(input.mode));
      }
      if (id === 'batch' && !action && method === 'POST') {
        const input = z
          .object({
            conversationId: z.string().min(1),
            batchId: z.string().min(1),
            ids: z.array(z.string().uuid()).min(1).max(100),
            approved: z.boolean(),
          })
          .strict()
          .parse(await jsonBody(request));
        return send(
          response,
          approvals.decideBatch(input.conversationId, input.batchId, input.ids, input.approved),
        );
      }
      if (id && !action && method === 'POST') {
        const input = z
          .union([
            z.object({ approved: z.boolean() }).strict(),
            z.object({ answer: z.string().trim().min(1).max(16000) }).strict(),
          ])
          .parse(await jsonBody(request));
        return send(
          response,
          'answer' in input
            ? approvals.answer(id, input.answer)
            : approvals.decide(id, input.approved),
        );
      }
      throw new ApiError(404, 'Not found');
    }
    if (resource === 'skills') {
      const workspaceId = url.searchParams.get('workspaceId') || 'default';
      workspaces.require(workspaceId);

      if (!id && method === 'GET')
        return send(
          response,
          skills.list(workspaceId, (url.searchParams.get('q') || '').slice(0, 2000)),
        );
      if (id === 'preview' && method === 'POST') {
        const input = z.object({ url: z.string().url().max(2000) }).parse(await jsonBody(request));
        const controller = new AbortController();
        const abort = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once('close', abort);
        try {
          return send(response, await skills.preview(input.url, controller.signal));
        } finally {
          response.off('close', abort);
        }
      }
      if (!id && method === 'POST')
        return send(
          response,
          skills.save(workspaceId, bundleSchema.parse(await jsonBody(request, 16 * 1024 * 1024))),
        );
      if (id && !action && method === 'GET') return send(response, skills.inspect(workspaceId, id));
      if (id && !action && method === 'PUT') {
        const input = z
          .object({ bundle: bundleSchema, expectedVersion: z.string().length(64) })
          .parse(await jsonBody(request, 16 * 1024 * 1024));
        return send(response, skills.save(workspaceId, input.bundle, id, input.expectedVersion));
      }
      if (id && action === 'enabled' && method === 'PUT') {
        const input = z.object({ enabled: z.boolean() }).parse(await jsonBody(request));
        return send(response, skills.enable(workspaceId, id, input.enabled));
      }
      if (id && !action && method === 'DELETE')
        return send(response, skills.remove(workspaceId, id));
      throw new ApiError(404, 'Not found');
    }
    if (resource === 'memory') {
      if (id === 'runs' && action === 'retry' && method === 'POST') {
        const workspaceId = url.searchParams.get('workspaceId') || 'default';
        workspaces.require(workspaceId);
        const input = z.object({ id: z.string().uuid() }).parse(await jsonBody(request));
        memory.retryRun(workspaceId, input.id);
        return send(response, { ok: true });
      }
      const workspaceId = url.searchParams.get('workspaceId') || 'default';
      workspaces.require(workspaceId);
      if (!id && method === 'GET')
        return send(
          response,
          memory.snapshot(
            workspaceId,
            (url.searchParams.get('q') || '').slice(0, 2000),
            url.searchParams.get('history') === 'true',
          ),
        );
      if (id === 'settings' && method === 'PUT')
        return send(
          response,
          memory.saveSettings(workspaceId, memorySettingsSchema.parse(await jsonBody(request))),
        );
      if (id === 'embeddings' && method === 'POST')
        return send(response, await memory.setupEmbeddings(workspaceId));
      if (id === 'export' && method === 'GET') return send(response, memory.export(workspaceId));
      if (id === 'import' && method === 'POST') {
        const input = z
          .object({
            version: z.literal(1),
            facts: z
              .array(
                z.object({
                  subject: z.string().min(1).max(180),
                  relation: z.string().min(1).max(80),
                  object: z.string().min(1).max(180),
                  text: z.string().min(1).max(1200),
                  validFrom: z.string().datetime({ offset: true }),
                  validTo: z.string().datetime({ offset: true }).nullable(),
                  state: z.enum(['confirmed', 'uncertain']),
                  ownerId: z.string().nullable().optional(),
                }),
              )
              .max(1000),
          })
          .parse(await jsonBody(request, 4 * 1024 * 1024));
        memory.import(workspaceId, input.facts);
        return send(response, { imported: input.facts.length });
      }
      if (!id && method === 'DELETE') {
        memory.clear(workspaceId);
        return send(response, { cleared: true });
      }
      if (id && action === 'correct' && method === 'POST') {
        const input = z
          .object({
            text: z.string().trim().min(1).max(1200),
            object: z.string().trim().min(1).max(180),
            validFrom: z.string().datetime({ offset: true }).optional(),
          })
          .parse(await jsonBody(request));
        return send(response, memory.correct(workspaceId, id, input));
      }
      if (id && action === 'retry' && method === 'POST') {
        memory.retry(workspaceId, id);
        return send(response, { queued: true });
      }
      if (id && action === 'episode' && method === 'DELETE') {
        memory.forgetEpisode(workspaceId, id);
        return send(response, { forgotten: true });
      }
      if (id && !action && method === 'DELETE') {
        memory.forget(workspaceId, id);
        return send(response, { forgotten: true });
      }
      throw new ApiError(404, 'Memory operation not found.');
    }
    if (resource === 'capabilities' || resource === 'environment') {
      const workspaceId = url.searchParams.get('workspaceId') || 'default';
      workspaces.require(workspaceId);
      if (resource === 'environment') {
        if (!id && method === 'GET')
          return send(response, capabilities.environment.list(workspaceId));
        if (!id && method === 'PUT') {
          const input = z
            .object({
              entries: z.array(z.object({ name: z.string(), value: z.string() })).max(200),
            })
            .parse(await jsonBody(request, 1024 * 1024));
          capabilities.environment.save(workspaceId, input.entries);
          return send(response, capabilities.environment.list(workspaceId));
        }
        if (id && method === 'DELETE') {
          capabilities.environment.remove(workspaceId, decodeURIComponent(id));
          return send(response, { removed: true });
        }
      } else {
        if (!id && method === 'GET') return send(response, capabilities.list(workspaceId));
        if (id && !action && method === 'GET')
          return send(response, capabilities.detail(id, workspaceId));
        if (!id && method === 'POST') {
          const { kind, ownerBotId, ...input } = z
            .object({
              kind: z.enum(['tool', 'route']),
              ownerBotId: z.string().optional(),
              ...registrationInput.shape,
            })
            .parse(await jsonBody(request));
          if (ownerBotId && bots.require(ownerBotId).workspaceId !== workspaceId)
            throw new ApiError(403, 'Owner bot belongs to another workspace.');
          return send(
            response,
            await capabilities.manage(workspaceId, ownerBotId || null, kind, input),
          );
        }
        if (id && action === 'test' && method === 'POST') {
          const { registration } = capabilities.detail(id, workspaceId);
          const input = await jsonBody(request, 1024 * 1024);
          if (registration.kind === 'route') {
            const sample = z
              .object({
                headers: z.record(z.string(), z.string()).default({}),
                rawBody: z.string().max(262144).default(''),
              })
              .parse(input);
            let parsed: unknown;
            try {
              parsed = JSON.parse(sample.rawBody);
            } catch {
              /* Preserve non-JSON bodies. */
            }
            return send(
              response,
              await capabilities.invoke(id, {
                method: registration.definition.method,
                url: registration.definition.path,
                headers: sample.headers,
                rawBody: Buffer.from(sample.rawBody),
                body: parsed,
              }),
            );
          }
          return send(response, await capabilities.invoke(id, input));
        }
      }
      throw new ApiError(404, 'Not found');
    }
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
            : url.searchParams.get('kind') === 'bot'
              ? conversations.botChats(workspaceId)
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
          if (conversation.kind === 'bot')
            throw new ApiError(403, 'Bot conversations are read-only for users.');
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
    } else if (resource === 'tools' && id === 'assignments') {
      const workspaceId = url.searchParams.get('workspaceId') || 'default';
      if (method === 'GET') return send(response, tools.assignments(workspaceId));
      if (method === 'PUT') {
        const value = z
          .object({ botId: z.string().min(1), toolId: z.string().min(1), enabled: z.boolean() })
          .parse(await jsonBody(request));
        return send(response, tools.assign(workspaceId, value.botId, value.toolId, value.enabled));
      }
      throw new ApiError(405, 'Method not allowed.');
    } else if (resource === 'tools' && !id && method === 'GET') {
      return send(response, tools.list(url.searchParams.get('workspaceId') || 'default'));
    } else if (resource === 'artifacts' && id && !action && method === 'GET') {
      const file = await artifacts.read(id);
      response.setHeader('Content-Type', file.mediaType);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      response.writeHead(200).end(file.bytes);
      return;
    } else if (resource === 'providers') {
      if (id === 'chatgpt-auth') {
        if (!action && method === 'POST') {
          const input = z
            .object({
              providerId: z.string().uuid().optional(),
              consent: z.boolean().optional(),
              retryAttemptId: z.string().uuid().optional(),
            })
            .parse(await jsonBody(request));
          return send(
            response,
            await providers.chatgpt.begin(input.providerId, input.consent, input.retryAttemptId),
          );
        }
        if (action && method === 'GET') return send(response, providers.chatgpt.status(action));
        if (action && method === 'DELETE') {
          providers.chatgpt.cancel(action);
          return send(response, { ok: true });
        }
      }
      if (id && action === 'models' && method === 'GET')
        return send(response, await providers.models(id));
      if (id && action === 'disconnect' && method === 'POST')
        return send(response, await providers.chatgpt.disconnect(id));
      if (!id && method === 'GET') return send(response, providers.list());
      if (!id && method === 'POST')
        return send(response, providers.save(providerSchema.parse(await jsonBody(request))), 201);
      if (id && method === 'PUT' && !action) {
        const input = providerSchema.parse(await jsonBody(request));
        await providers.validateModel(id, input.defaultModel);
        return send(response, providers.save(input, id));
      }
      if (id && method === 'DELETE' && !action) {
        return send(response, await providers.remove(id));
      }
      if (id && action === 'test' && method === 'POST')
        return send(response, await providers.test(id));
    } else if (resource === 'bots') {
      if (!id && method === 'GET')
        return send(response, bots.list(url.searchParams.get('workspaceId') || 'default'));
      if (!id && method === 'POST') {
        const value = createBotSchema.parse(await jsonBody(request));
        await providers.validateModel(value.providerId, value.model);
        return send(response, bots.save(value, undefined, value.workspaceId), 201);
      }
      const bot = bots.require(id || '');
      if (action === 'model' && method === 'PUT') {
        const input = botModelSchema.parse(await jsonBody(request));
        await providers.validateModel(input.providerId, input.model);
        return send(response, bots.setModel(bot.id, input));
      }
      if (action === 'conversations' && method === 'POST')
        return send(response, conversations.createPrivate(bot.id), 201);
      if (method === 'PUT' && !action) {
        const input = botSchema.parse(await jsonBody(request));
        await providers.validateModel(input.providerId, input.model);
        return send(response, bots.save(input, id));
      }
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
