import type { SkillService } from '../skills/service';
import { skillTools } from '../tools/skills/execute';
import type { Bot, ChatActivity, ToolInfo } from '../../shared/ai';
import {
  toolCatalog,
  toolsForBot,
  pursuitTools,
  runtimeTools,
  botManagementTools,
} from '../tools/registry';
import type { ToolSet } from 'ai';
import type { ToolAccessService } from './toolAccessService';
import type { BotManagementService } from './botManagementService';
import type { PursuitService } from './pursuitService';
import { MessageRepository } from '../repositories/messageRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';
import { ArtifactService } from './artifactService';
import { FileChangeService } from './fileChangeService';
import type { BrowserService } from './browserService';
import type { ProcessService } from './processService';
import { FILE_TOOL_CALL_LIMIT, RUNTIME_TOOL_CALL_LIMIT } from './responsePolicy';
import type { CapabilityService } from '../capabilities/service';
import type { MemoryService } from './memoryService';
import { memoryTools } from '../tools/memory/execute';
import { memoryDefinition } from '../tools/memory/definition';
import { systemTools } from '../tools/system/execute';
import { WebSearchService } from './webSearchService';
import type { AskHandler } from '../tools/ask/execute';
import { communicateTools } from '../tools/communicate/execute';
import { conversationTools } from '../tools/conversations/execute';
import type { NotificationService } from './notificationService';
import type { ConversationArtifactService } from './conversationArtifactService';
import type { ConversationHistoryService } from './conversationHistoryService';
import { computerTools } from '../computer/tools';
import { executeWebSearch } from '../tools/web-search/execute';
import { webSearchDefinition } from '../tools/web-search/definition';
import { tool } from 'ai';
import { ComputerUseService } from './computerUseService';
import type { InputCapabilities } from '../../shared/modelCapabilities';
import { terminalDefinition } from '../tools/terminal/definition';

export class ToolService {
  private notifications?: NotificationService;
  private history?: ConversationHistoryService;
  private conversationArtifacts?: ConversationArtifactService;
  attachArtifacts(service: ConversationArtifactService) {
    this.conversationArtifacts = service;
  }
  attachCommunication(notifications: NotificationService, history: ConversationHistoryService) {
    this.notifications = notifications;
    this.history = history;
  }
  private webSearch = new WebSearchService();
  private access?: ToolAccessService;
  private management?: BotManagementService;
  attachBotManagement(access: ToolAccessService, management: BotManagementService) {
    this.access = access;
    this.management = management;
  }
  resumeBackgroundDelegations(bot: Bot, messageId: string, signal: AbortSignal) {
    this.management?.resumeBackground(bot, messageId, signal);
  }
  assignments(workspaceId: string) {
    this.workspaces.require(workspaceId);
    return this.access?.list(workspaceId) || [];
  }
  assign(workspaceId: string, botId: string, toolId: string, enabled: boolean) {
    this.workspaces.require(workspaceId);
    if (!this.access) throw new Error('Tool assignments are unavailable.');
    return this.access.set(workspaceId, botId, toolId, enabled);
  }
  private assigned(bot: Bot, tools: ToolSet, ids: Record<string, string> = {}) {
    const assigned: ToolSet = {};
    for (const [name, definition] of Object.entries(tools)) {
      const id = ids[name] || name;
      if (this.access && !this.access.allowed(bot, id)) continue;
      const execute = definition.execute;
      assigned[name] = {
        ...definition,
        ...(execute
          ? {
              execute: (input, options) => {
                this.access?.require(bot, id);
                return execute(input, options);
              },
            }
          : {}),
      };
    }
    return assigned;
  }
  private skills?: SkillService;
  attachSkills(service: SkillService) {
    this.skills = service;
  }
  skillContext(bot: Bot, conversationId: string) {
    return this.skills?.context(bot.workspaceId, bot.id, conversationId) || '';
  }
  private memory?: MemoryService;
  attachMemory(service: MemoryService) {
    this.memory = service;
  }
  private capabilities?: CapabilityService;
  attachCapabilities(service: CapabilityService) {
    this.capabilities = service;
  }
  customRegistration(bot: Bot, name: string) {
    const registration = this.capabilities
      ?.list(bot.workspaceId)
      .find((item) => item.kind === 'tool' && item.definition.name === name);
    if (registration) this.access?.require(bot, 'custom:' + registration.id);
    return registration;
  }
  validateTerminalEnvironment(bot: Bot, input: unknown) {
    this.access?.require(bot, 'terminal');
    const names = terminalDefinition.inputSchema.parse(input).envFromSettings || [];
    if (!names.length) return;
    if (!this.capabilities) throw new Error('Workspace environment variables are unavailable.');
    this.capabilities.environment.resolveForTerminal(bot.workspaceId, names);
  }
  prepareCustomConfirmation(
    bot: Bot,
    name: string,
    conversationId: string,
    messageId: string,
    toolCallId: string,
    input: unknown,
  ) {
    const registration = this.customRegistration(bot, name);
    if (!registration || registration.status !== 'ready')
      throw new Error('Custom tool is unavailable.');
    return this.capabilities!.prepareConfirmation(
      registration,
      bot,
      conversationId,
      messageId,
      toolCallId,
      input,
    );
  }
  customConfirmation(id: string, bot: Bot, conversationId: string, messageId: string) {
    if (!this.capabilities) throw new Error('Custom tools are unavailable.');
    const pending = this.capabilities.confirmation(id, bot, conversationId, messageId);
    this.access?.require(bot, 'custom:' + pending.registration.id);
    return pending;
  }
  executeCustomConfirmation(
    id: string,
    bot: Bot,
    conversationId: string,
    messageId: string,
    signal: AbortSignal,
    beforeExecute: () => void,
  ) {
    this.customConfirmation(id, bot, conversationId, messageId);
    return this.capabilities!.executeConfirmation(
      id,
      bot,
      conversationId,
      messageId,
      signal,
      beforeExecute,
    );
  }
  cancelCustomConfirmation(id: string) {
    this.capabilities?.cancelConfirmation(id);
  }
  cancelCustomConfirmations(messageId: string) {
    this.capabilities?.cancelConfirmations(messageId);
  }
  customForBot(bot: Bot, signal: AbortSignal, onActivity: (activity: ChatActivity) => void) {
    const ids = Object.fromEntries(
      (this.capabilities?.list(bot.workspaceId) || [])
        .filter((item) => item.kind === 'tool')
        .map((item) => [item.definition.name, 'custom:' + item.id]),
    );
    return this.assigned(bot, this.capabilities?.forBot(bot, signal, onActivity) || {}, ids);
  }
  private pursuits?: PursuitService;
  attachPursuits(service: PursuitService) {
    this.pursuits = service;
  }
  currentPursuits(bot: Bot) {
    return (this.pursuits?.list(bot.workspaceId) || []).filter(
      (pursuit) => pursuit.ownerBotId === bot.id && pursuit.status !== 'completed',
    );
  }
  constructor(
    private workspaces: WorkspaceService,
    private artifacts: ArtifactService,
    private messages: MessageRepository,
    private dataDir: string,
    private changes: FileChangeService,
    private processes: ProcessService,
    private browsers: BrowserService,
    private desktop: ComputerUseService = new ComputerUseService(),
  ) {}
  list(workspaceId: string): ToolInfo[] {
    const workspace = this.workspaces.require(workspaceId);
    const canCopyAttachments = this.conversationArtifacts?.hasAttachments(workspaceId);
    const counts = this.messages.toolCounts(workspaceId);
    const memoryCounts = Object.fromEntries(
      // Include activities saved before the three tools became one family.
      memoryDefinition.actions.map((action) => [
        action,
        (counts.memory?.[action] || 0) + (counts[`memory_${action}`]?.[action] || 0),
      ]),
    );
    return toolCatalog().map((tool) => ({
      ...tool,
      ...(tool.id === 'file_operations' &&
      workspace.computer !== 'qemu' &&
      !workspace.folder &&
      canCopyAttachments
        ? {
            actions: ['copy_attachment'],
            description: 'Copy a saved upload to an absolute path on the local computer.',
          }
        : {}),
      ...(workspace.computer === 'qemu' &&
      ['terminal', 'media', 'browser', 'file_operations', 'computer_use'].includes(tool.id)
        ? {
            description:
              tool.id === 'computer_use'
                ? 'See and control the workspace Linux VM desktop, mouse, and keyboard.'
                : tool.id === 'browser'
                  ? 'Control workspace or main Chrome on the Linux VM desktop.'
                  : tool.id === 'media'
                    ? 'Read and inspect images, audio and video on the Linux VM or by saved reference.'
                    : tool.id === 'terminal'
                      ? 'Run Linux commands and manage guest processes.'
                      : 'Read, write and organize files inside the workspace Linux VM.',
          }
        : {}),
      scope: ['skills', 'register_custom_route', 'manage_bot'].includes(tool.id)
        ? 'all-bots'
        : 'selected-bots',
      available:
        tool.id === 'skills'
          ? Boolean(this.skills)
          : tool.id === 'memory'
            ? Boolean(this.memory)
            : tool.id === 'manage_bot'
              ? Boolean(this.management)
              : tool.id === 'manage_pursuit'
                ? Boolean(this.pursuits)
                : tool.id === 'system' || tool.id.startsWith('register_custom_')
                  ? Boolean(this.capabilities)
                  : [
                        'browser',
                        'computer_use',
                        'media',
                        'web_search',
                        'communicate',
                        'conversations',
                        ...(canCopyAttachments ? ['file_operations'] : []),
                      ].includes(tool.id)
                    ? true
                    : workspace.computer === 'qemu' || Boolean(workspace.folder),
      counts:
        tool.id === 'memory'
          ? memoryCounts
          : tool.id === 'communicate'
            ? Object.fromEntries(
                tool.actions.map((action) => [
                  action,
                  (counts.communicate?.[action] || 0) + (counts.ask?.[action] || 0),
                ]),
              )
            : tool.id === 'media'
              ? {
                  ...counts.media,
                  read_image: (counts.media?.read_image || 0) + (counts.image?.read || 0),
                  view_image: (counts.media?.view_image || 0) + (counts.image?.view || 0),
                }
              : counts[tool.id] || {},
    }));
  }
  checkpointScope(bot: Bot) {
    const workspace = this.workspaces.require(bot.workspaceId);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      computer: workspace.computer,
      folder: workspace.computer === 'qemu' ? '/home/mukai/workspace' : workspace.folder,
      computerSystem:
        workspace.computer === 'qemu'
          ? 'Your computer is a persistent Linux VM shared with this workspace’s bots. Shell: /bin/sh. Project: /home/mukai/workspace. All terminal, process, file, media, browser and computer_use operations run inside that VM. Absolute paths refer to Linux guest paths. Chrome and computer_use actions are visible on the guest desktop. Terminal commands and custom handlers automatically receive MUKAI_ROUTES_URL (the host gateway and actual running port) and MUKAI_ROUTES_TOKEN (temporary, workspace-scoped; send as Authorization: Bearer). Use these variables rather than hardcoding addresses or reading the master API token. auth:session is for browser login and does not accept the route token. Custom modules can use context.callRoute instead without handling credentials. Write custom tool/route modules inside the VM, then register them using workspace-relative module paths. Mukai manages registrations, approvals and route endpoints; module compilation and execution run inside this VM. Host project mounts are unavailable. Web search, memory, skills and scheduling are controller services.'
          : undefined,
    };
  }
  fileOperationsReady(workspaceId: string) {
    const workspace = this.workspaces.require(workspaceId);
    return (
      workspace.computer === 'qemu' ||
      !!workspace.folder ||
      !!this.conversationArtifacts?.hasAttachments(workspaceId)
    );
  }
  forBot(
    bot: Bot,
    messageId: string,
    signal: AbortSignal,
    onActivity: (activity: ChatActivity) => void,
    inputs: boolean | InputCapabilities = false,
    resultBytes?: number,
    skillContextBytes?: number,
    ask?: AskHandler,
    futureAttachments = false,
  ) {
    const capabilities =
      typeof inputs === 'boolean'
        ? { supportsImages: inputs, supportsAudio: false, supportsVideo: false }
        : inputs;
    const vision = capabilities.supportsImages;
    const workspace = this.workspaces.require(bot.workspaceId);
    const conversationId = this.messages.message(messageId).conversationId;
    const scheduledRun = Boolean(
      conversationId && this.pursuits?.isRunConversation(conversationId),
    );
    const runtime = {
      owner: { botId: bot.id, workspaceId: bot.workspaceId, conversationId: conversationId! },
      signal,
      onActivity,
      budget: { remaining: RUNTIME_TOOL_CALL_LIMIT },
      vision,
      supportsAudio: capabilities.supportsAudio,
      supportsVideo: capabilities.supportsVideo,
      resultBytes,
      routeEnvironment: this.capabilities
        ? (lifetimeMs: number, active?: () => Promise<boolean>) =>
            this.capabilities!.routeEnvironment(bot.workspaceId, lifetimeMs, active)
        : undefined,
      isTerminalRunning: async (sessionId: string) => {
        const result = await this.workspaces
          .computers!.guest(workspace)
          .requestRunning(
            'process',
            { action: 'poll', sessionId },
            { workspaceId: bot.workspaceId, botId: bot.id, conversationId: conversationId! },
            AbortSignal.timeout(3000),
          );
        return (result as { status?: string }).status === 'running';
      },
      resolveTerminalEnvironment: (names: string[]) => {
        if (!this.capabilities) throw new Error('Workspace environment variables are unavailable.');
        return this.capabilities.environment.resolveForTerminal(bot.workspaceId, names);
      },
      readImage: this.conversationArtifacts
        ? async (input: { attachmentId?: string; artifactId?: string }) => {
            const source = await this.conversationArtifacts!.bytes(bot.workspaceId, input);
            return { bytes: source.bytes, name: source.metadata.name };
          }
        : undefined,
    };
    const attachmentBytes = this.conversationArtifacts
      ? async (id: string) =>
          (await this.conversationArtifacts!.bytes(bot.workspaceId, { attachmentId: id })).bytes
      : undefined;
    return this.assigned(
      bot,
      {
        ...(ask && this.notifications
          ? communicateTools({
              ask,
              signal,
              onActivity,
              notify: (input, toolCallId) =>
                this.notifications!.notify(bot, messageId, toolCallId, input),
            })
          : {}),
        ...(this.history
          ? conversationTools({
              history: this.history,
              artifacts: this.conversationArtifacts,
              workspaceId: bot.workspaceId,
              signal,
              onActivity,
            })
          : {}),
        ...(this.skills
          ? skillTools({
              bot,
              conversationId: conversationId!,
              skills: this.skills,
              maxContextBytes: skillContextBytes,
              signal,
              onActivity,
            })
          : {}),
        ...(this.memory && this.memory.settings(bot.workspaceId).enabled
          ? memoryTools({
              bot,
              conversationId: conversationId!,
              messageId,
              memory: this.memory,
              signal,
              onActivity,
            })
          : {}),
        ...(this.capabilities
          ? systemTools({
              bot,
              conversationId: conversationId!,
              environment: this.capabilities.environment,
              signal,
              onActivity,
            })
          : {}),
        ...this.customForBot(bot, signal, onActivity),
        ...(workspace.computer === 'qemu'
          ? {
              ...computerTools({
                ...runtime,
                computer: this.workspaces.computers!.guest(workspace),
                attachmentBytes,
                fileBudget: { remaining: FILE_TOOL_CALL_LIMIT },
                recordChange: (snapshot) => this.changes.record(bot.id, messageId, snapshot),
                recordFile: (path, metadata) =>
                  this.artifacts.record(bot.id, messageId, path, metadata),
                saveScreenshot: (image) =>
                  this.artifacts.recordScreenshot(bot.id, messageId, image, signal),
              }),
              web_search: tool({
                description: webSearchDefinition.description,
                inputSchema: webSearchDefinition.inputSchema,
                execute: (input, options) =>
                  executeWebSearch(
                    input,
                    { ...runtime, webSearch: this.webSearch },
                    options.toolCallId,
                  ),
              }),
            }
          : runtimeTools({
              owner: {
                botId: bot.id,
                workspaceId: bot.workspaceId,
                conversationId: conversationId!,
              },
              signal,
              onActivity,
              budget: { remaining: RUNTIME_TOOL_CALL_LIMIT },
              processes: this.processes,
              browsers: this.browsers,
              desktop: this.desktop,
              webSearch: this.webSearch,
              folder: workspace.folder,
              vision,
              supportsAudio: capabilities.supportsAudio,
              supportsVideo: capabilities.supportsVideo,
              resultBytes,
              resolveTerminalEnvironment: runtime.resolveTerminalEnvironment,
              readImage: runtime.readImage,
              saveScreenshot: (image) =>
                this.artifacts.recordScreenshot(bot.id, messageId, image, signal),
            })),
        ...(workspace.computer !== 'qemu' &&
        (workspace.folder ||
          futureAttachments ||
          this.conversationArtifacts?.hasAttachments(bot.workspaceId))
          ? toolsForBot({
              botId: bot.id,
              signal,
              files: new WorkspaceFileService(workspace.folder || '', this.dataDir, (snapshot) =>
                this.changes.record(bot.id, messageId, snapshot),
              ),
              onActivity,
              onFileChanged: (path, metadata) =>
                this.artifacts.record(bot.id, messageId, path, metadata),
              attachmentBytes,
              copyOnly: !workspace.folder,
              callBudget: { remaining: FILE_TOOL_CALL_LIMIT },
            })
          : {}),
        ...(this.pursuits
          ? pursuitTools({
              bot,
              pursuits: this.pursuits,
              onActivity,
              signal,
              scheduledRun,
              conversationId,
            })
          : {}),
        ...(this.management
          ? botManagementTools({ bot, management: this.management, signal, onActivity, messageId })
          : {}),
      },
      Object.fromEntries(
        (this.capabilities?.list(bot.workspaceId) || [])
          .filter(
            (item) =>
              item.kind === 'tool' &&
              !toolCatalog().some((builtin) => builtin.id === item.definition.name),
          )
          .map((item) => [item.definition.name, 'custom:' + item.id]),
      ),
    );
  }
}
