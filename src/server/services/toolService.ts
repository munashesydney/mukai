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
import { askTools, type AskHandler } from '../tools/ask/execute';

export class ToolService {
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
                  ? Boolean(this.capabilities)
                  : ['browser', 'image', 'web_search', 'ask'].includes(tool.id)
                    ? true
                    : Boolean(workspace.folder),
      counts: tool.id === 'memory' ? memoryCounts : counts[tool.id] || {},
    }));
  }
  checkpointScope(bot: Bot) {
    const workspace = this.workspaces.require(bot.workspaceId);
    return { workspaceId: workspace.id, folder: workspace.folder };
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
    return this.assigned(
      bot,
      {
        ...(ask ? askTools({ ask, signal, onActivity }) : {}),
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
        ...runtimeTools({
          owner: { botId: bot.id, workspaceId: bot.workspaceId, conversationId: conversationId! },
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
        }),
        ...(workspace.folder
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
          ? pursuitTools({ bot, pursuits: this.pursuits, onActivity, signal, scheduledRun })
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
