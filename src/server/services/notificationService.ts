import type { Bot } from '../../shared/ai';
import type { NotificationRepository } from '../repositories/notificationRepository';
import type { WorkspaceService } from './workspaceService';

export class NotificationService {
  constructor(
    private repository: NotificationRepository,
    private workspaces: WorkspaceService,
  ) {}
  notify(
    bot: Bot,
    messageId: string,
    toolCallId: string,
    input: { title: string; message: string },
  ) {
    this.workspaces.require(bot.workspaceId);
    return this.repository.notify(bot, messageId, toolCallId, input);
  }
  list(workspaceId: string, offset = 0) {
    this.workspaces.require(workspaceId);
    return this.repository.list(workspaceId, offset);
  }
  mark(workspaceId: string, id: string, action: 'read' | 'dismiss') {
    this.workspaces.require(workspaceId);
    return this.repository.mark(workspaceId, id, action);
  }
  continue(workspaceId: string, id: string) {
    this.workspaces.require(workspaceId);
    return this.repository.continue(workspaceId, id);
  }
}
