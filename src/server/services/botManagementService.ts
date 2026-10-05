import { randomUUID } from 'node:crypto';
import type { Bot, BotInput, ChatMessage } from '../../shared/ai';
import { ApiError } from '../config';
import type { BotService } from './botService';
import type { ChatService } from './chatService';
import type { ConversationService } from './conversationService';
import type { ToolAccessService } from './toolAccessService';
import type { ProviderService } from './providerService';
import type { ChatJobRepository } from '../repositories/chatJobRepository';

export class BotManagementService {
  private reserved = new Map<string, string>();
  constructor(
    private bots: BotService,
    private chats: ChatService,
    private conversations: ConversationService,
    private access: ToolAccessService,
    private providers: ProviderService,
    private jobs: ChatJobRepository,
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
  requireMessageTarget(caller: Bot, botId: string) {
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
    return target;
  }
  async sendMessage(
    caller: Bot,
    botId: string,
    message: string,
    signal: AbortSignal,
    conversationId?: string,
    delegation?: {
      parentMessageId?: string;
      toolCallId: string;
      onStarted: (value: {
        botId: string;
        botName: string;
        conversationId: string;
        requestId: string;
      }) => void;
    },
  ) {
    signal.throwIfAborted();
    const target = this.requireMessageTarget(caller, botId);
    caller = this.bots.require(caller.id);
    const saved = delegation?.parentMessageId
      ? this.jobs.delegation(delegation.parentMessageId, delegation.toolCallId)
      : undefined;
    if (
      saved &&
      (saved.callerId !== caller.id ||
        saved.targetId !== target.id ||
        saved.message !== message ||
        (conversationId && conversationId !== saved.conversationId))
    )
      throw new ApiError(409, 'The saved bot request does not match this tool call.');
    if (saved?.state === 'cancelled')
      throw new ApiError(409, 'This bot request was cancelled. Send a new message to start again.');
    const requestId = saved?.childRequestId || randomUUID();
    if (
      (this.reserved.has(target.id) && this.reserved.get(target.id) !== requestId) ||
      (this.chats.busy(target.id) &&
        !this.chats.runningRequest(saved?.conversationId || '', requestId, target.id))
    )
      throw new ApiError(
        409,
        'That bot is already working. Try again after its response finishes.',
      );
    this.providers.resolve(target);
    const conversation = this.conversations.botChat(
      caller,
      target,
      message,
      saved?.conversationId || conversationId,
    );
    if (!saved && delegation?.parentMessageId)
      this.jobs.saveDelegation({
        parentMessageId: delegation.parentMessageId,
        toolCallId: delegation.toolCallId,
        callerId: caller.id,
        targetId: target.id,
        conversationId: conversation.id,
        childRequestId: requestId,
        message,
        state: 'waiting',
      });
    delegation?.onStarted({
      botId: target.id,
      botName: target.name,
      conversationId: conversation.id,
      requestId,
    });
    const abort = () => {
      if (this.chats.isClosing) return;
      if (delegation?.parentMessageId)
        this.jobs.delegationState(delegation.parentMessageId, delegation.toolCallId, 'cancelled');
      this.chats.stopConversation(conversation.id);
    };
    signal.addEventListener('abort', abort, { once: true });
    this.reserved.set(target.id, requestId);
    let response: ChatMessage | undefined;
    try {
      await this.chats.respond(
        target,
        {
          requestId,
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
        Boolean(saved),
      );
      signal.throwIfAborted();
      if (!response) throw new ApiError(500, 'The bot did not return a saved response.');
      if (delegation?.parentMessageId)
        this.jobs.delegationState(delegation.parentMessageId, delegation.toolCallId, 'complete');
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
