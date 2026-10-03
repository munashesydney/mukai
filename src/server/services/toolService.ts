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

export class ToolService {
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
    return toolCatalog().map((tool) => ({
      ...tool,
      available:
        tool.id === 'manage_pursuit'
          ? Boolean(this.pursuits)
          : tool.id === 'browser'
            ? true
            : Boolean(workspace.folder),
      counts: counts[tool.id] || {},
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
  ) {
    const workspace = this.workspaces.require(bot.workspaceId);
    const conversationId = this.messages.message(messageId).conversationId;
    const scheduledRun = Boolean(
      conversationId && this.pursuits?.isRunConversation(conversationId),
    );
    return {
      ...runtimeTools({
        owner: { botId: bot.id, workspaceId: bot.workspaceId, conversationId: conversationId! },
        signal,
        onActivity,
        budget: { remaining: RUNTIME_TOOL_CALL_LIMIT },
        processes: this.processes,
        browsers: this.browsers,
        folder: workspace.folder,
        vision,
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
