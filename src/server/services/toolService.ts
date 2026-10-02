import type { Bot, ChatActivity, ToolInfo } from '../../shared/ai';
import { toolCatalog, toolsForBot } from '../tools/registry';
import { MessageRepository } from '../repositories/messageRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';
import { ArtifactService } from './artifactService';
import { FileChangeService } from './fileChangeService';

export class ToolService {
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
      available: Boolean(workspace.folder),
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
    if (!workspace.folder) return {};
    return toolsForBot({
      botId: bot.id,
      signal,
      files: new WorkspaceFileService(workspace.folder, this.dataDir, (snapshot) =>
        this.changes.record(bot.id, messageId, snapshot),
      ),
      onActivity,
      onFileChanged: (path) => this.artifacts.record(bot.id, messageId, path),
      callBudget: { remaining: 16 },
    });
  }
}
