import { ApiError } from '../config';
import type { MemoryService } from './memoryService';
import { ConversationRepository } from '../repositories/conversationRepository';
import { MessageRepository } from '../repositories/messageRepository';
import { BotService } from './botService';
import { ChatService, type ChatOutput } from './chatService';
import type { SpaceInput, SpaceChatInput } from '../../shared/conversations';
import type { Bot, ChatInput } from '../../shared/ai';

export class ConversationService {
  constructor(
    private conversations: ConversationRepository,
    private messages: MessageRepository,
    private bots: BotService,
    private chats: ChatService,
    private memory?: MemoryService,
  ) {}
  require(id: string) {
    const conversation = this.conversations.find(id);
    if (!conversation) throw new ApiError(404, 'Conversation not found.');
    return conversation;
  }
  list(workspaceId: string) {
    this.bots.list(workspaceId);
    return this.conversations.list(workspaceId);
  }
  privateChats(workspaceId: string) {
    this.bots.list(workspaceId);
    return this.conversations.privateChats(workspaceId);
  }
  createPrivate(botId: string) {
    const bot = this.bots.require(botId);
    return this.conversations.createPrivate(bot.workspaceId, bot.id);
  }
  botChats(workspaceId: string) {
    this.bots.list(workspaceId);
    return this.conversations.botChats(workspaceId);
  }
  botChat(caller: Bot, target: Bot, message: string, id?: string) {
    if (id) {
      const conversation = this.require(id);
      if (
        conversation.kind !== 'bot' ||
        conversation.workspaceId !== caller.workspaceId ||
        conversation.botIds.length !== 2 ||
        !conversation.botIds.includes(caller.id) ||
        !conversation.botIds.includes(target.id)
      )
        throw new ApiError(
          403,
          'Choose a bot conversation between you and the target bot in this workspace.',
        );
      return conversation;
    }
    return this.conversations.createBotChat(caller.workspaceId, caller.id, target.id, message);
  }
  privateBot(id: string) {
    const conversation = this.require(id);
    if (
      conversation.kind !== 'private' ||
      !conversation.ownerBotId ||
      !conversation.botIds.includes(conversation.ownerBotId)
    )
      throw new ApiError(400, 'This is not a private bot conversation.');
    const bot = this.bots.require(conversation.ownerBotId);
    if (bot.workspaceId !== conversation.workspaceId)
      throw new ApiError(400, 'Conversation workspace does not match its bot.');
    return bot;
  }
  sendPrivate(id: string, input: ChatInput, output: ChatOutput, source?: 'telegram') {
    return this.chats.respond(this.privateBot(id), { ...input, source }, output, id);
  }
  userChatBot(id: string) {
    const conversation = this.require(id);
    if (conversation.kind === 'private') return this.privateBot(id);
    if (conversation.kind !== 'bot' || conversation.botIds.length !== 2)
      throw new ApiError(400, 'Choose a private or bot-to-bot conversation.');
    // Participant order records the original sender and receiver, independently of display order.
    const bot = this.bots.require(conversation.botIds[1]);
    if (bot.workspaceId !== conversation.workspaceId)
      throw new ApiError(400, 'Conversation workspace does not match its bot.');
    return bot;
  }
  sendToBot(id: string, input: ChatInput, output: ChatOutput) {
    const bot = this.userChatBot(id);
    const existing = this.messages.forRequest(id, input.requestId, 'user');
    if (this.require(id).kind === 'bot' && existing?.botId)
      throw new ApiError(403, 'Bot-authored requests cannot be retried as a user.');
    return this.chats.respond(bot, input, output, id);
  }
  create(workspaceId: string, input: SpaceInput) {
    const available = this.bots.list(workspaceId);
    if (input.botIds.some((id) => !available.some((bot) => bot.id === id)))
      throw new ApiError(400, 'Choose bots from this workspace.');
    return this.conversations.create(workspaceId, { ...input, botIds: [...new Set(input.botIds)] });
  }
  import(workspaceId: string, spaces: Parameters<ConversationRepository['import']>[1]) {
    const bots = this.bots.list(workspaceId);
    return this.conversations.import(
      workspaceId,
      spaces,
      bots.map((bot) => bot.id),
    );
  }
  history(id: string) {
    this.require(id);
    return this.chats.conversationHistory(id);
  }
  latestBotReply(id: string, botId: string, requestId?: string) {
    this.require(id);
    return this.messages.latestBotReply(id, botId, requestId);
  }
  save(id: string, messageId: string, saved: boolean) {
    this.require(id);
    if (!this.messages.setSaved(id, messageId, saved))
      throw new ApiError(404, 'Message not found in this conversation.');
    return this.messages.message(messageId);
  }
  async send(id: string, input: SpaceChatInput, output: ChatOutput) {
    const conversation = this.require(id);
    if (conversation.kind !== 'space')
      throw new ApiError(400, 'Use the private bot chat endpoint.');
    if (input.botId) {
      if (!conversation.botIds.includes(input.botId))
        throw new ApiError(400, 'That bot does not belong to this space.');
      const bot = this.bots.require(input.botId);
      return this.chats.respond(
        bot,
        { requestId: input.requestId, text: input.text, attachmentIds: [] },
        output,
        id,
      );
    }
    if (!input.text.trim()) throw new ApiError(400, 'Write a message.');
    const existing = this.messages.forRequest(id, input.requestId, 'user');
    if (existing && this.messages.forRequest(id, input.requestId, 'assistant'))
      throw new ApiError(409, 'This message already requested a bot response.');
    const message = existing
      ? this.messages.message(existing.id)
      : this.messages.createUser(id, input.requestId, input.text);
    const actorId = conversation.botIds[0];
    if (actorId) {
      try {
        this.memory?.capture(this.bots.require(actorId), id, message.id);
      } catch {
        /* A saved space message remains usable if capture is unavailable. */
      }
    }
    output.start();
    output.emit({ type: 'done', message });
    output.end();
  }
  stop(id: string) {
    this.require(id);
    this.chats.stopConversation(id);
  }
}
