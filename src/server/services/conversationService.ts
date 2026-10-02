import { ApiError } from '../config';
import { ConversationRepository } from '../repositories/conversationRepository';
import { MessageRepository } from '../repositories/messageRepository';
import { BotService } from './botService';
import { ChatService, type ChatOutput } from './chatService';
import type { SpaceInput, SpaceChatInput } from '../../shared/conversations';
import type { ChatInput } from '../../shared/ai';

export class ConversationService {
  constructor(
    private conversations: ConversationRepository,
    private messages: MessageRepository,
    private bots: BotService,
    private chats: ChatService,
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
  sendPrivate(id: string, input: ChatInput, output: ChatOutput) {
    return this.chats.respond(this.privateBot(id), input, output, id);
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
    output.start();
    output.emit({ type: 'done', message });
    output.end();
  }
  stop(id: string) {
    this.require(id);
    this.chats.stopConversation(id);
  }
}
