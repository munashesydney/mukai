import { SkillService } from './skills/service';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database } from './db/database';
import { defaultDataDir, privateSecret, acquireDataLock } from './config';
import { BotRepository } from './repositories/botRepository';
import { ProviderRepository } from './repositories/providerRepository';
import { AttachmentRepository } from './repositories/attachmentRepository';
import { MessageRepository } from './repositories/messageRepository';
import { ChatJobRepository } from './repositories/chatJobRepository';
import { ChatFollowupRepository } from './repositories/chatFollowupRepository';
import { BotService } from './services/botService';
import { ProviderService } from './services/providerService';
import { AttachmentService } from './services/attachmentService';
import { ChatService } from './services/chatService';
import { ApprovalService } from './services/approvalService';
import { ApprovalRepository } from './repositories/approvalRepository';
import { createRoutes } from './http/routes';
import { ChatOutputService } from './services/chatOutputService';
import { ChatOutputRepository } from './repositories/chatOutputRepository';
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
import { NotificationService } from './services/notificationService';
import { ConversationHistoryService } from './services/conversationHistoryService';
import { NotificationRepository } from './repositories/notificationRepository';
import { ConversationHistoryRepository } from './repositories/conversationHistoryRepository';
import { PursuitService } from './services/pursuitService';
import { PursuitRepository } from './repositories/pursuitRepository';
import { LimitsRepository } from './repositories/limitsRepository';
import { SettingsRepository } from './repositories/settingsRepository';
import { SettingsService } from './services/settingsService';
import { ToolAccessService } from './services/toolAccessService';
import { ToolAssignmentRepository } from './repositories/toolAssignmentRepository';
import { BotManagementService } from './services/botManagementService';
import { ProcessService } from './services/processService';
import { ComputerManager } from './computer/manager';
import { DesktopTransport } from './computer/desktopTransport';
import { BrowserService } from './services/browserService';
import { ComputerUseService } from './services/computerUseService';
import { NativeDesktopBackend } from './computer/computer_use/nativeBackend';
import type { EmbeddedBrowserHost } from './browser/types';
import { DiagnosticService } from './services/diagnosticService';
import { ApiError } from './config';
import { ZodError } from 'zod';
import { createWebHandler } from './web/handler';
import { BrowserSession } from './web/session';
import { OwnerAuth } from './web/ownerAuth';
import { localBrowserRequest } from './web/origin';
import { CapabilityService } from './capabilities/service';
import { MemoryService } from './services/memoryService';
import type { Extractor } from '../../mukai_memory/src';
import { TelegramConnectionRepository } from './repositories/telegramConnectionRepository';
import { TelegramSessionRepository } from './repositories/telegramSessionRepository';
import { TelegramJobRepository } from './repositories/telegramJobRepository';
import { TelegramService } from './services/telegramService';
import { TelegramRuntime } from './telegram/runtime';

export interface ApiOptions {
  webDir?: string;
  version?: string;
  dataDir?: string;
  token?: string;
  embeddedBrowser?: EmbeddedBrowserHost;
  /** Deterministic extractor for tests or a host-provided memory model. */
  memoryExtractor?: Extractor;
  memoryReviewIdleMs?: number;
  guestBundleDir?: string;
  desktopHelperDir?: string;
  /** Injectable transport for integration tests; production always uses the fixed Telegram origin. */
  telegramFetch?: typeof fetch;
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
    const settings = new SettingsService(new SettingsRepository(store));
    const computers = new ComputerManager(dir, options.guestBundleDir, diagnostics);
    const workspaces = new WorkspaceService(workspaceRepository, dir, computers);
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
    const desktop = new ComputerUseService(new NativeDesktopBackend(options.desktopHelperDir));
    const tools = new ToolService(
      workspaces,
      artifacts,
      messageRepository,
      dir,
      changes,
      processes,
      browsers,
      desktop,
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
    const approvals = new ApprovalService(new ApprovalRepository(store));
    const notifications = new NotificationService(new NotificationRepository(store), workspaces);
    const conversationHistory = new ConversationHistoryService(
      new ConversationHistoryRepository(store),
      workspaces,
    );
    tools.attachCommunication(notifications, conversationHistory);
    const jobs = new ChatJobRepository(store);
    const chats = new ChatService(
      messageRepository,
      providers,
      attachments,
      tools,
      jobs,
      diagnostics,
      memory,
      approvals,
      new ChatFollowupRepository(store),
    );
    const bots = new BotService(
      botRepository,
      providerRepository,
      attachments,
      (id) => chats.busy(id),
      workspaceRepository,
    );
    chats.initialize();
    chats.attachFollowups((id) => bots.require(id));
    capabilities.setWake(async (botId, workspaceId, message, requestId) => {
      const bot = bots.require(botId);
      if (bot.workspaceId !== workspaceId)
        throw new ApiError(403, 'Bot belongs to another workspace.');
      if (chats.busy(botId)) throw new ApiError(409, 'Target bot is busy; the wake-up will retry.');
      // The durable wake job ID keeps retries in the same new conversation.
      const conversation = new ConversationRepository(store).createPrivate(
        workspaceId,
        botId,
        requestId,
      );
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
        conversation.id,
      );
    });
    const pursuits = new PursuitService(
      new PursuitRepository(store),
      bots,
      chats,
      Date.now,
      new LimitsRepository(store),
    );
    tools.attachPursuits(pursuits);
    const conversations = new ConversationService(
      new ConversationRepository(store),
      messageRepository,
      bots,
      chats,
      memory,
    );
    const telegram = new TelegramService(
      new TelegramConnectionRepository(store),
      new TelegramSessionRepository(store),
      new TelegramJobRepository(store),
      workspaces,
      bots,
      conversations,
      chats,
      diagnostics,
      dir,
      options.telegramFetch,
    );
    const telegramRuntime = new TelegramRuntime(telegram);
    const access = new ToolAccessService(new ToolAssignmentRepository(store));
    const botManagement = new BotManagementService(
      bots,
      chats,
      conversations,
      access,
      providers,
      jobs,
    );
    tools.attachBotManagement(access, botManagement);
    capabilities.setWakeTargetValidator((botId, workspaceId, ownerBotId) => {
      const target = bots.require(botId);
      if (target.workspaceId !== workspaceId)
        throw new ApiError(403, 'Bot belongs to another workspace.');
      if (ownerBotId && ownerBotId !== botId)
        botManagement.requireMessageTarget(bots.require(ownerBotId), botId);
    });
    const ownerAuth = options.webDir ? new OwnerAuth(store) : undefined;
    const browserSession = options.webDir ? new BrowserSession(randomUUID()) : undefined;
    const desktops = new DesktopTransport(
      Boolean(options.webDir),
      ownerAuth
        ? (request) =>
            ownerAuth.authenticated(request) ||
            (!ownerAuth.configured() &&
              localBrowserRequest(request) &&
              Boolean(browserSession?.authenticated(request)))
        : undefined,
    );
    computers.attachDisposalHandler((computer) => desktops.forget(computer));
    attachments.attachDeletionGuard((id) => {
      bots.require(id);
    });
    workspaces.attachDeletionHandler(async (id) => {
      telegram.stopWorkspace(id);
      const botIds = botRepository.list(id).map((bot) => bot.id);
      // Mark both schedulers stopped synchronously before awaiting cancellations.
      const pursuitStop = pursuits.stopWorkspace(id);
      const chatStop = chats.stopWorkspace(id, botIds);
      const capabilityStop = capabilities.stopWorkspace(id);
      await Promise.all([pursuitStop, chatStop, capabilityStop]);
      approvals.forgetWorkspace(id, botIds);
      await memory.stopWorkspace(id);
      await processes.stopWorkspace(id);
      await browsers.stopWorkspace(id);
    });
    const chatOutputs = new ChatOutputService(
      new ChatOutputRepository(store),
      conversations,
      workspaces,
      processes,
      computers,
      browsers,
    );
    const route = createRoutes({
      telegram,
      settings,
      browserMode: Boolean(options.webDir),
      version: options.version,
      chatOutputs,
      notifications,
      desktops,
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
    });
    if (browserSession) diagnostics.registerSecret(browserSession.connectToken);
    if (ownerAuth) diagnostics.registerSecret(ownerAuth.setupCode);
    const handler =
      options.webDir && browserSession
        ? createWebHandler(options.webDir, token, browserSession, route, ownerAuth)
        : route;
    const server = createServer((request, response) => {
      void handler(request, response).catch((error) => {
        if (!(error instanceof ApiError) && !(error instanceof ZodError))
          diagnostics.record('http.failed', error, { phase: 'http-request' });
        sendError(response, error);
      });
    });
    desktops.attach(server);

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
        desktops.shutdown();
        providers.chatgpt.shutdown();
        // Stop new capability jobs before stopping chat runs that may be processing wakes.
        const capabilityShutdown = capabilities.shutdown();
        const telegramShutdown = telegramRuntime.shutdown();
        pursuits.stopScheduling();
        await chats.shutdown();
        await telegramShutdown;
        await pursuits.shutdown();
        await memory.shutdown();
        await capabilityShutdown;
        await processes.shutdown();
        await computers.shutdown();
        await browsers.shutdown();
        await desktop.shutdown();
        await workspaces.waitForDeletions();
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
      chats.restorePending((id) => bots.require(id));
      chats.restoreFollowups();
      pursuits.start();
      capabilities.start();
      memory.start();
      telegramRuntime.start();
    });
    return {
      browserSession,
      ownerAuth,
      notifications,
      conversationHistory,
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
      computers,
      workspaces,
      capabilities,
      memory,
      skills,
      telegram,
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
    await api.computers.initialize();
    await api.capabilities.initialize();
    await api.workspaces.resumeDeletions();
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject);
      api.server.listen(port, '127.0.0.1', () => {
        api.server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await api.shutdown();
    api.dispose();
    throw error;
  }
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind the Mukai API');
  api.capabilities.setLocalBaseUrl(`http://127.0.0.1:${address.port}`);
  return { ...api, url: `http://127.0.0.1:${address.port}` };
}
