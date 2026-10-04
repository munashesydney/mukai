import type { SkillService } from '../skills/service';
import { skillTools } from '../tools/skills/execute';
import type { Bot, ChatActivity, ToolInfo } from '../../shared/ai';
import { toolCatalog, toolsForBot, pursuitTools, runtimeTools } from '../tools/registry';
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

export class ToolService {
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
  customForBot(bot: Bot, signal: AbortSignal, onActivity: (activity: ChatActivity) => void) {
    return this.capabilities?.forBot(bot, signal, onActivity) || {};
  }
  private pursuits?: PursuitService;
  attachPursuits(service: PursuitService) {
    this.pursuits = service;
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
      available:
        tool.id === 'skills'
          ? Boolean(this.skills)
          : tool.id === 'memory'
            ? Boolean(this.memory)
            : tool.id === 'manage_pursuit'
              ? Boolean(this.pursuits)
              : tool.id.startsWith('register_custom_')
                ? Boolean(this.capabilities)
                : tool.id === 'browser'
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
  ) {
    const workspace = this.workspaces.require(bot.workspaceId);
    const conversationId = this.messages.message(messageId).conversationId;
    const scheduledRun = Boolean(
      conversationId && this.pursuits?.isRunConversation(conversationId),
    );
    return {
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
        folder: workspace.folder,
        vision,
        resultBytes,
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
    };
  }
}
