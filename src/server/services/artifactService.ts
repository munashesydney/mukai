import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../config';
import { ArtifactRepository } from '../repositories/artifactRepository';
import { BotRepository } from '../repositories/botRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';

export class ArtifactService {
  constructor(
    private artifacts: ArtifactRepository,
    private bots: BotRepository,
    private workspaces: WorkspaceService,
    private dataDir: string,
  ) {}
  list(botId: string) {
    return this.artifacts.list(botId);
  }
  forConversation(id: string) {
    return this.artifacts.forConversation(id);
  }
  record(botId: string, messageId: string, path: string) {
    this.artifacts.save({
      id: randomUUID(),
      botId,
      messageId,
      path,
      name: basename(path),
      createdAt: new Date().toISOString(),
    });
  }
  async read(id: string) {
    const artifact = this.artifacts.find(id);
    const bot = artifact && this.bots.find(artifact.botId);
    if (!artifact || !bot) throw new ApiError(404, 'Artifact not found.');
    const workspace = this.workspaces.require(bot.workspaceId);
    if (!workspace.folder) throw new ApiError(400, 'This workspace has no folder.');
    return new WorkspaceFileService(workspace.folder, this.dataDir).download(artifact.path);
  }
}
