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
import { WebSearchService } from './webSearchService';
import type { AskHandler } from '../tools/ask/execute';
import { communicateTools } from '../tools/communicate/execute';
import { conversationTools } from '../tools/conversations/execute';
import type { NotificationService } from './notificationService';
import type { ConversationHistoryService } from './conversationHistoryService';
import { computerTools } from '../computer/tools';
import { executeWebSearch } from '../tools/web-search/execute';
import { webSearchDefinition } from '../tools/web-search/definition';
import { tool } from 'ai';

export class ToolService {
  private notifications?: NotificationService;
  private history?: ConversationHistoryService;
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
    if (this.workspaces.require(bot.workspaceId).computer === 'qemu') return {};
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
  ) {}
  list(workspaceId: string): ToolInfo[] {
    const workspace = this.workspaces.require(workspaceId);
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
      ...(workspace.computer === 'qemu' &&
      ['terminal', 'image', 'browser', 'file_operations'].includes(tool.id)
        ? {
            description:
              tool.id === 'browser'
                ? 'Control workspace or main Chrome on the Linux VM desktop.'
                : tool.id === 'image'
                  ? 'Read and view guest images inside the Linux VM.'
                  : tool.id === 'terminal'
                    ? 'Run Linux commands and manage guest processes.'
                    : 'Read, write and organize files inside the workspace Linux VM.',
          }
        : {}),
      scope: ['skills', 'register_custom_route'].includes(tool.id) ? 'all-bots' : 'selected-bots',
      available:
        tool.id === 'skills'
          ? Boolean(this.skills)
          : tool.id === 'memory'
            ? Boolean(this.memory)
            : tool.id === 'manage_bot'
              ? Boolean(this.management)
              : tool.id === 'manage_pursuit'
                ? Boolean(this.pursuits)
                : tool.id.startsWith('register_custom_')
                  ? workspace.computer !== 'qemu' && Boolean(this.capabilities)
                  : ['browser', 'image', 'web_search', 'communicate', 'conversations'].includes(
                        tool.id,
                      )
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
            : counts[tool.id] || {},
    }));
  }
  checkpointScope(bot: Bot) {
    const workspace = this.workspaces.require(bot.workspaceId);
    return {
      workspaceId: workspace.id,
      computer: workspace.computer,
      folder: workspace.computer === 'qemu' ? '/home/mukai/workspace' : workspace.folder,
      computerSystem:
        workspace.computer === 'qemu'
          ? 'Your computer is a persistent Linux VM shared with this workspace’s bots. Shell: /bin/sh. Project: /home/mukai/workspace. All terminal, process, file, image and browser operations run inside that VM. Absolute paths refer to Linux guest paths. Chrome is visible on the guest desktop. Custom tool/route registration and host project mounts are unavailable in VM v1. Web search, memory, skills and scheduling are controller services.'
          : undefined,
    };
  }
  forBot(
    bot: Bot,
    messageId: string,
    signal: AbortSignal,
    onActivity: (activity: ChatActivity) => void,
    vision = false,
    resultBytes?: number,
    skillContextBytes?: number,
    ask?: AskHandler,
  ) {
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
      resultBytes,
    };
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
        ...(this.memory
          ? memoryTools({
              bot,
              conversationId: conversationId!,
              messageId,
              memory: this.memory,
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
                fileBudget: { remaining: FILE_TOOL_CALL_LIMIT },
                recordChange: (snapshot) => this.changes.record(bot.id, messageId, snapshot),
                recordFile: (path) => this.artifacts.record(bot.id, messageId, path),
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
              webSearch: this.webSearch,
              folder: workspace.folder,
              vision,
              resultBytes,
              saveScreenshot: (image) =>
                this.artifacts.recordScreenshot(bot.id, messageId, image, signal),
            })),
        ...(workspace.computer !== 'qemu' && workspace.folder
          ? toolsForBot({
              botId: bot.id,
              signal,
              files: new WorkspaceFileService(workspace.folder, this.dataDir, (snapshot) =>
                this.changes.record(bot.id, messageId, snapshot),
              ),
              onActivity,
              onFileChanged: (path) => this.artifacts.record(bot.id, messageId, path),
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
          .filter((item) => item.kind === 'tool')
          .map((item) => [item.definition.name, 'custom:' + item.id]),
      ),
    );
  }
}
