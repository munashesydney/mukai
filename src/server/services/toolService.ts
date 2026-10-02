import type { Bot, ChatActivity, ToolInfo } from '../../shared/ai';
import { toolCatalog, toolsForBot, pursuitTools } from '../tools/registry';
import type { PursuitService } from './pursuitService';
import { MessageRepository } from '../repositories/messageRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';
import { ArtifactService } from './artifactService';
import { FileChangeService } from './fileChangeService';

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
  ) {}
  list(workspaceId: string): ToolInfo[] {
    const workspace = this.workspaces.require(workspaceId);
    const counts = this.messages.toolCounts(workspaceId);
    return toolCatalog().map((tool) => ({
      ...tool,
      available: tool.id === 'manage_pursuit' ? Boolean(this.pursuits) : Boolean(workspace.folder),
      counts: counts[tool.id] || {},
    }));
  }
  forBot(
    bot: Bot,
    messageId: string,
    signal: AbortSignal,
    onActivity: (activity: ChatActivity) => void,
  ) {
    const workspace = this.workspaces.require(bot.workspaceId);
    const conversationId = this.messages.message(messageId).conversationId;
    const scheduledRun = Boolean(
      conversationId && this.pursuits?.isRunConversation(conversationId),
    );
    return {
      ...(workspace.folder
        ? toolsForBot({
            botId: bot.id,
            signal,
            files: new WorkspaceFileService(workspace.folder, this.dataDir, (snapshot) =>
              this.changes.record(bot.id, messageId, snapshot),
            ),
            onActivity,
            onFileChanged: (path) => this.artifacts.record(bot.id, messageId, path),
            callBudget: { remaining: 16 },
          })
        : {}),
      ...(this.pursuits
        ? pursuitTools({ bot, pursuits: this.pursuits, onActivity, signal, scheduledRun })
        : {}),
    };
  }
}
