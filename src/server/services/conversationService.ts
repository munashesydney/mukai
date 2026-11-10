import { ApiError } from '../config';
import type { MemoryService } from './memoryService';
import { ConversationRepository } from '../repositories/conversationRepository';
import { MessageRepository } from '../repositories/messageRepository';
import { BotService } from './botService';
import { ChatService, type ChatOutput } from './chatService';
import type {
  SpaceInput,
  SpaceChatInput,
  ConversationHistoryPage,
} from '../../shared/conversations';
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
  workingWorkspaceIds() {
    return this.conversations.workingWorkspaceIds();
  }
  list(workspaceId: string) {
    this.bots.list(workspaceId);
    return this.conversations.list(workspaceId);
  }
  historyPage(workspaceId: string, limit: number, cursor?: string): ConversationHistoryPage {
    let before: { updatedAt: string; id: string } | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          value.workspaceId !== workspaceId ||
          typeof value.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(value.updatedAt)) ||
          typeof value.id !== 'string' ||
          !value.id
        )
          throw new Error('Invalid cursor');
        before = { updatedAt: value.updatedAt, id: value.id };
      } catch {
        throw new ApiError(400, 'Invalid conversation history cursor.');
      }
    }
    this.bots.list(workspaceId);
    const page = this.conversations.historyPage(workspaceId, limit, before);
    const last = page.conversations.at(-1);
    return {
      conversations: page.conversations,
      nextCursor:
        page.hasMore && last
          ? Buffer.from(
              JSON.stringify({ workspaceId, updatedAt: last.updatedAt, id: last.id }),
            ).toString('base64url')
          : null,
    };
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
    const botId =
      conversation.kind === 'pursuit_run' && conversation.botIds.length === 1
        ? conversation.botIds[0]
        : conversation.kind === 'bot' && conversation.botIds.length === 2
          ? conversation.botIds[1]
          : undefined;
    if (!botId) throw new ApiError(400, 'This conversation has no available responding bot.');
    // Participant order records the original sender and receiver, independently of display order.
    const bot = this.bots.require(botId);
    if (bot.workspaceId !== conversation.workspaceId)
      throw new ApiError(400, 'Conversation workspace does not match its bot.');
    return bot;
  }
  sendToBot(id: string, input: ChatInput, output: ChatOutput) {
    const bot = this.userChatBot(id);
    const conversation = this.require(id);
    const existing = this.messages.forRequest(id, input.requestId, 'user');
    if (conversation.kind === 'bot' && existing?.botId)
      throw new ApiError(403, 'Bot-authored requests cannot be retried as a user.');
    if (conversation.kind === 'pursuit_run') {
      if (this.chats.pursuitRunning(id))
        throw new ApiError(409, 'This run is still working. Queue a follow-up instead.');
      if (input.requestId === this.chats.pursuitRequest(id))
        throw new ApiError(400, 'Retry pursuit runs through their pursuit.');
    }
    return this.chats.respond(bot, input, output, id);
  }
  retry(id: string, messageId: string, output: ChatOutput) {
    const conversation = this.require(id);
    let message;
    try {
      message = this.messages.message(messageId);
    } catch {
      throw new ApiError(404, 'Response not found in this conversation.');
    }
    if (message.conversationId !== id || message.role !== 'assistant' || !message.botId)
      throw new ApiError(404, 'Response not found in this conversation.');
    if (
      conversation.kind === 'pursuit_run' &&
      (this.chats.pursuitRunning(id) || message.requestId === this.chats.pursuitRequest(id))
    )
      throw new ApiError(400, 'Retry pursuit runs through their pursuit.');
    if (!['failed', 'interrupted', 'stopped'].includes(message.status))
      throw new ApiError(409, 'Only an unfinished response can be retried.');
    const bot = this.bots.require(message.botId);
    if (bot.workspaceId !== conversation.workspaceId || !conversation.botIds.includes(bot.id))
      throw new ApiError(403, 'The original bot no longer belongs to this conversation.');
    // This explicit owner action preserves saved bot-authored provenance; /chat still forbids spoofing it.
    return this.chats.respond(
      bot,
      { requestId: message.requestId, text: '', attachmentIds: [] },
      output,
      id,
    );
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
