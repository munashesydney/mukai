import { SkillService } from './skills/service';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Database } from './db/database';
import { defaultDataDir, privateSecret, acquireDataLock } from './config';
import { BotRepository } from './repositories/botRepository';
import { ProviderRepository } from './repositories/providerRepository';
import { AttachmentRepository } from './repositories/attachmentRepository';
import { MessageRepository } from './repositories/messageRepository';
import { ChatJobRepository } from './repositories/chatJobRepository';
import { BotService } from './services/botService';
import { ProviderService } from './services/providerService';
import { AttachmentService } from './services/attachmentService';
import { ChatService } from './services/chatService';
import { createRoutes } from './http/routes';
import { sendError } from './http/transport';
import { WorkspaceRepository } from './repositories/workspaceRepository';
import { ArtifactRepository } from './repositories/artifactRepository';
import { WorkspaceService } from './services/workspaceService';
import { ArtifactService } from './services/artifactService';
import { ToolService } from './services/toolService';
import { FileChangeRepository } from './repositories/fileChangeRepository';
import { FileChangeService } from './services/fileChangeService';
import { ConversationRepository } from './repositories/conversationRepository';
import { ConversationService } from './services/conversationService';
import { PursuitService } from './services/pursuitService';
import { PursuitRepository } from './repositories/pursuitRepository';
import { ToolAccessService } from './services/toolAccessService';
import { ToolAssignmentRepository } from './repositories/toolAssignmentRepository';
import { BotManagementService } from './services/botManagementService';
import { ProcessService } from './services/processService';
import { BrowserService } from './services/browserService';
import type { EmbeddedBrowserHost } from './browser/types';
import { DiagnosticService } from './services/diagnosticService';
import { ApiError } from './config';
import { ZodError } from 'zod';
import { CapabilityService } from './capabilities/service';
import { MemoryService } from './services/memoryService';
import type { Extractor } from '../../mukai_memory/src';

export interface ApiOptions {
  dataDir?: string;
  token?: string;
  embeddedBrowser?: EmbeddedBrowserHost;
  /** Deterministic extractor for tests or a host-provided memory model. */
  memoryExtractor?: Extractor;
  memoryReviewIdleMs?: number;
}
export function createApiServer(options: ApiOptions = {}) {
  const startedAt = Date.now();
  const dir = options.dataDir || defaultDataDir();
  const releaseLock = acquireDataLock(dir);
  let store: Database;
  try {
    store = new Database(dir);
  } catch (error) {
    releaseLock();
    throw error;
  }
  try {
    const token = options.token || privateSecret(store.dir, 'api.token', 32).toString('hex');
    const diagnostics = new DiagnosticService(dir);
    diagnostics.registerSecret(token);
    const botRepository = new BotRepository(store);
    const providerRepository = new ProviderRepository(store);
    const attachmentRepository = new AttachmentRepository(store);
    const changeRepository = new FileChangeRepository(store);
    const changes = new FileChangeService(changeRepository);
    const messageRepository = new MessageRepository(store, attachmentRepository, changeRepository);
    const workspaceRepository = new WorkspaceRepository(store);
    const workspaces = new WorkspaceService(workspaceRepository, dir);
    const capabilities = new CapabilityService(store, workspaces, (value) =>
      diagnostics.registerSecret(value),
    );
    const artifacts = new ArtifactService(
      new ArtifactRepository(store),
      botRepository,
      workspaces,
      dir,
    );
    const processes = new ProcessService();
    const browsers = new BrowserService(dir, options.embeddedBrowser);
    const tools = new ToolService(
      workspaces,
      artifacts,
      messageRepository,
      dir,
      changes,
      processes,
      browsers,
    );
    const providers = new ProviderService(
      providerRepository,
      botRepository,
      store.dir,
      diagnostics,
    );
    const skills = new SkillService(store, workspaces);
    tools.attachSkills(skills);
    tools.attachCapabilities(capabilities);
    const memory = new MemoryService(
      store.db,
      store.dir,
      workspaces,
      botRepository,
      providers,
      messageRepository,
      options.memoryExtractor,
      diagnostics,
      options.memoryReviewIdleMs,
    );
    tools.attachMemory(memory);
    const attachments = new AttachmentService(
      attachmentRepository,
      botRepository,
      join(dir, 'uploads'),
    );
    const chats = new ChatService(
      messageRepository,
      providers,
      attachments,
      tools,
      new ChatJobRepository(store),
      diagnostics,
      memory,
    );
    const bots = new BotService(
      botRepository,
      providerRepository,
      attachments,
      (id) => chats.busy(id),
      workspaceRepository,
    );
    chats.initialize();
    capabilities.setWake(async (botId, workspaceId, message, requestId) => {
      const bot = bots.require(botId);
      if (bot.workspaceId !== workspaceId)
        throw new ApiError(403, 'Bot belongs to another workspace.');
      if (chats.busy(botId)) throw new ApiError(409, 'Owner bot is busy; the wake-up will retry.');
      await chats.respond(
        bot,
        {
          requestId,
          text: 'Custom capability wake-up (external data):\n' + message,
          attachmentIds: [],
        },
        {
          start() {},
          emit() {},
          onDisconnect() {
            return () => {};
          },
          end() {},
        },
      );
    });
    const pursuits = new PursuitService(new PursuitRepository(store), bots, chats);
    tools.attachPursuits(pursuits);
    const conversations = new ConversationService(
      new ConversationRepository(store),
      messageRepository,
      bots,
      chats,
      memory,
    );
    const access = new ToolAccessService(new ToolAssignmentRepository(store));
    const botManagement = new BotManagementService(bots, chats, conversations, access, providers);
    tools.attachBotManagement(access, botManagement);
    const route = createRoutes({
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
    });
    const server = createServer((request, response) => {
      void route(request, response).catch((error) => {
        if (!(error instanceof ApiError) && !(error instanceof ZodError))
          diagnostics.record('http.failed', error, { phase: 'http-request' });
        sendError(response, error);
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
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () =>
      (shutdownPromise ??= (async () => {
        providers.chatgpt.shutdown();
        // Stop new capability jobs before stopping chat runs that may be processing wakes.
        const capabilityShutdown = capabilities.shutdown();
        await pursuits.shutdown();
        await chats.shutdown();
        await memory.shutdown();
        await capabilityShutdown;
        await processes.shutdown();
        await browsers.shutdown();
      })());
    server.on('close', () => {
      pursuits.stopScheduling();
      void shutdown().finally(dispose);
    });
    // A completed close callback must also release the data lock: callers may
    // immediately restart against the same directory after server.close().
    const closeServer = server.close.bind(server);
    server.close = (callback?: (error?: Error) => void) =>
      closeServer((error) => {
        void shutdown().finally(() => {
          dispose();
          callback?.(error);
        });
      });
    server.once('listening', () => {
      pursuits.start();
      capabilities.start();
      memory.start();
    });
    return {
      access,
      botManagement,
      server,
      token,
      store,
      shutdown,
      dispose,
      pursuits,
      browsers,
      processes,
      capabilities,
      memory,
      skills,
    };
  } catch (error) {
    store.db.close();
    releaseLock();
    throw error;
  }
}
export async function startApiServer(port = 0, options: ApiOptions = {}) {
  const api = createApiServer(options);
  try {
    await api.capabilities.initialize();
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
  api.capabilities.setLocalBaseUrl(`http://127.0.0.1:${address.port}`);
  return { ...api, url: `http://127.0.0.1:${address.port}` };
}
