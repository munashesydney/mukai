import { randomUUID } from 'node:crypto';
import type { Bot, BotInput, ChatMessage } from '../../shared/ai';
import { ApiError } from '../config';
import type { BotService } from './botService';
import type { ChatService } from './chatService';
import type { ConversationService } from './conversationService';
import type { ToolAccessService } from './toolAccessService';
import type { ProviderService } from './providerService';

export class BotManagementService {
  private reserved = new Set<string>();
  constructor(
    private bots: BotService,
    private chats: ChatService,
    private conversations: ConversationService,
    private access: ToolAccessService,
    private providers: ProviderService,
  ) {}
  list(caller: Bot) {
    this.access.require(caller, 'manage_bot');
    return this.bots.list(caller.workspaceId).map(({ id, name, role, createdBy, isMain }) => ({
      id,
      name,
      role,
      createdBy,
      isMain,
    }));
  }
  async create(caller: Bot, input: BotInput, toolIds?: string[]) {
    this.access.require(caller, 'manage_bot');
    this.access.validateSelection(caller, toolIds);
    await this.providers.validateModel(input.providerId, input.model);
    return this.bots.save(input, undefined, caller.workspaceId, caller.id, (child) => {
      this.access.require(caller, 'manage_bot');
      this.access.initializeChild(caller, child, toolIds);
    });
  }
  private subordinate(caller: Bot, target: Bot) {
    if (caller.workspaceId !== target.workspaceId || caller.id === target.id) return false;
    const visited = new Set<string>();
    let parent = target.createdBy;
    while (parent && !visited.has(parent)) {
      if (parent === caller.id) return true;
      visited.add(parent);
      parent = this.bots.require(parent).createdBy;
    }
    return false;
  }
  async spawn(caller: Bot, botId: string, message: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.access.require(caller, 'manage_bot');
    const target = this.bots.require(botId);
    if (!this.subordinate(caller, target))
      throw new ApiError(403, 'You may spawn only bots below you in this workspace’s hierarchy.');
    if (this.reserved.has(target.id) || this.chats.busy(target.id))
      throw new ApiError(
        409,
        'That bot is already working. Try again after its response finishes.',
      );
    this.providers.resolve(target);
    const conversation = this.conversations.createPrivate(target.id);
    const abort = () => this.chats.stopConversation(conversation.id);
    signal.addEventListener('abort', abort, { once: true });
    this.reserved.add(target.id);
    let response: ChatMessage | undefined;
    try {
      await this.chats.respond(
        target,
        {
          requestId: randomUUID(),
          text: `Work delegated by ${caller.name} (bot ${caller.id}):\n${message}`,
          attachmentIds: [],
        },
        {
          start() {},
          emit(event) {
            if (event.type === 'done' || event.type === 'error') response = event.message;
          },
          onDisconnect() {
            return () => {};
          },
          end() {},
        },
        conversation.id,
      );
      signal.throwIfAborted();
      if (!response) throw new ApiError(500, 'The bot did not return a saved response.');
      return {
        botId,
        conversationId: conversation.id,
        messageId: response.id,
        status: response.status,
        response: response.content.slice(-12000),
        error: response.error,
      };
    } finally {
      this.reserved.delete(target.id);
      signal.removeEventListener('abort', abort);
    }
  }
}
