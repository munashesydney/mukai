import type { ConversationQuery } from '../tools/conversations/definition';
import type { ConversationHistoryRepository } from '../repositories/conversationHistoryRepository';
import type { WorkspaceService } from './workspaceService';

export class ConversationHistoryService {
  constructor(
    private repository: ConversationHistoryRepository,
    private workspaces: WorkspaceService,
  ) {}
  execute(workspaceId: string, input: ConversationQuery) {
    this.workspaces.require(workspaceId);
    return this.repository.execute(workspaceId, input);
  }
}
