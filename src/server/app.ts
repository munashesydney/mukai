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
import { ProcessService } from './services/processService';
import { BrowserService } from './services/browserService';
import type { EmbeddedBrowserHost } from './browser/types';

export interface ApiOptions {
  dataDir?: string;
  token?: string;
  embeddedBrowser?: EmbeddedBrowserHost;
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
    const botRepository = new BotRepository(store);
    const providerRepository = new ProviderRepository(store);
    const attachmentRepository = new AttachmentRepository(store);
    const changeRepository = new FileChangeRepository(store);
    const changes = new FileChangeService(changeRepository);
    const messageRepository = new MessageRepository(store, attachmentRepository, changeRepository);
    const workspaceRepository = new WorkspaceRepository(store);
    const workspaces = new WorkspaceService(workspaceRepository, botRepository, dir);
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
    const providers = new ProviderService(providerRepository, botRepository, store.dir);
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
    );
    const bots = new BotService(
      botRepository,
      providerRepository,
      attachments,
      (id) => chats.busy(id),
      workspaceRepository,
    );
    bots.initialize();
    chats.initialize();
    const pursuits = new PursuitService(new PursuitRepository(store), bots, chats);
    tools.attachPursuits(pursuits);
    const conversations = new ConversationService(
      new ConversationRepository(store),
      messageRepository,
      bots,
      chats,
    );
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
    });
    const server = createServer((request, response) => {
      void route(request, response).catch((error) => sendError(response, error));
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
        await pursuits.shutdown();
        await chats.shutdown();
        await processes.shutdown();
        await browsers.shutdown();
      })());
    server.on('close', () => {
      pursuits.stopScheduling();
      if (!pursuits.hasActiveRuns() && !chats.hasActiveResponses()) dispose();
      void shutdown().finally(dispose);
    });
    server.once('listening', () => pursuits.start());
    return { server, token, store, shutdown, dispose, pursuits, browsers, processes };
  } catch (error) {
    store.db.close();
    releaseLock();
    throw error;
  }
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
