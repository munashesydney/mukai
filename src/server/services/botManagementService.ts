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
    return this.bots.list(caller.workspaceId).map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      createdBy: bot.createdBy,
      isMain: bot.isMain,
      hierarchyLevel: this.level(bot),
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
  private level(bot: Bot) {
    const visited = new Set<string>();
    let current = bot,
      level = 0;
    while (current.createdBy) {
      if (visited.has(current.id)) throw new ApiError(409, 'The bot hierarchy contains a cycle.');
      visited.add(current.id);
      const parent = this.bots.require(current.createdBy);
      if (parent.workspaceId !== bot.workspaceId)
        throw new ApiError(409, 'The bot hierarchy crosses workspaces.');
      current = parent;
      level++;
    }
    return level;
  }
  async sendMessage(
    caller: Bot,
    botId: string,
    message: string,
    signal: AbortSignal,
    conversationId?: string,
  ) {
    signal.throwIfAborted();
    this.access.require(caller, 'manage_bot');
    caller = this.bots.require(caller.id);
    const target = this.bots.require(botId);
    if (
      caller.workspaceId !== target.workspaceId ||
      caller.id === target.id ||
      this.level(target) < this.level(caller)
    )
      throw new ApiError(
        403,
        'You may message only peers or lower-level bots in this workspace’s hierarchy, never yourself or higher-level bots.',
      );
    if (this.reserved.has(target.id) || this.chats.busy(target.id))
      throw new ApiError(
        409,
        'That bot is already working. Try again after its response finishes.',
      );
    this.providers.resolve(target);
    const conversation = this.conversations.botChat(caller, target, message, conversationId);
    const abort = () => this.chats.stopConversation(conversation.id);
    signal.addEventListener('abort', abort, { once: true });
    this.reserved.add(target.id);
    let response: ChatMessage | undefined;
    try {
      await this.chats.respond(
        target,
        {
          requestId: randomUUID(),
          text: message,
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
        undefined,
        caller,
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
