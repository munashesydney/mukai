import { randomUUID } from 'node:crypto';
import type { Bot, BotInput, ChatMessage, ChatActivity } from '../../shared/ai';
import { ApiError } from '../config';
import type { BotService } from './botService';
import type { ChatService } from './chatService';
import type { ConversationService } from './conversationService';
import type { ToolAccessService } from './toolAccessService';
import type { ProviderService } from './providerService';
import type { ChatJobRepository, DelegationResult } from '../repositories/chatJobRepository';
import { outsidePursuitExecution, pausePursuitTask } from './pursuitScheduler';
import type { z } from 'zod';
import { botManagementDefinition } from '../tools/bots/definition';

type BotAction = z.infer<typeof botManagementDefinition.inputSchema>['action'];

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
  actionsFor(caller: Bot, messageId?: string): BotAction[] {
    const current = this.bots.require(caller.id);
    if (current.isMain)
      return [
        'create',
        'update',
        'delete',
        'list',
        'get',
        'list_models',
        'get_model',
        'send_message',
        'get_last_message',
      ];
    return messageId && this.chats.delegatedMessage(messageId)
      ? ['list', 'get', 'list_models', 'get_model', 'get_last_message']
      : ['list', 'get', 'list_models', 'get_model', 'send_message', 'get_last_message'];
  }
  requireAction(caller: Bot, action: BotAction, messageId?: string) {
    this.access.require(caller, 'manage_bot');
    if (!this.actionsFor(caller, messageId).includes(action))
      throw new ApiError(
        403,
        action === 'send_message'
          ? 'send_message is intentionally unavailable in a delegated sub-bot run to prevent delegation loops. Return your final reply to the calling bot.'
          : 'Only the workspace main bot can create, update, or delete bots. Ask the user to discuss this with the main bot.',
      );
  }
  get(caller: Bot, botId: string) {
    this.requireAction(caller, 'get');
    const target = this.bots.require(botId);
    if (target.workspaceId !== caller.workspaceId)
      throw new ApiError(403, 'Bot belongs to another workspace.');
    return { ...target, hierarchyLevel: this.level(target) };
  }
  /** Project effective values only at the tool boundary; keep saved overrides untouched. */
  describe(bot: Bot) {
    const configuration = Object.fromEntries(
      Object.entries(bot).filter(([key]) => key !== 'avatar'),
    );
    return {
      ...configuration,
      ...this.providers.describeModel(bot),
      hierarchyLevel: this.level(bot),
    };
  }
  remove(caller: Bot, botId: string) {
    this.requireAction(caller, 'delete');
    const target = this.get(caller, botId);
    if (target.id === caller.id || target.isMain)
      throw new ApiError(403, 'The main bot cannot delete itself.');
    this.bots.remove(target.id);
    return { deleted: true, botId: target.id, name: target.name };
  }
  async update(
    caller: Bot,
    botId: string,
    patch: Pick<
      z.infer<typeof botManagementDefinition.inputSchema>,
      'name' | 'role' | 'instructions' | 'toolIds' | 'modelId'
    >,
    signal?: AbortSignal,
  ) {
    this.requireAction(caller, 'update');
    let target = this.get(caller, botId);
    if (Object.values(patch).every((value) => value === undefined))
      throw new ApiError(400, 'Update requires at least one field.');
    this.access.validateSelection(caller, patch.toolIds);
    const { toolIds, modelId, ...fields } = patch;
    const selection = modelId ? this.providers.resolveModelSelection(modelId) : undefined;
    if (modelId && selection) {
      if (this.chats.busy(botId) || this.reserved.has(botId))
        throw new ApiError(409, 'Stop this bot’s response before editing it.');
      const checkSignal = signal ?? new AbortController().signal;
      await this.providers.testBotModel({ ...selection, supportsImages: null }, checkSignal);
      await this.providers.validateModel(selection.providerId, selection.model);
      checkSignal.throwIfAborted();
      this.providers.resolveModelSelection(modelId);
      // Re-read after the connection test so unrelated edits are not overwritten.
      this.requireAction(caller, 'update');
      target = this.get(caller, botId);
      this.access.validateSelection(caller, toolIds);
      if (this.chats.busy(botId) || this.reserved.has(botId))
        throw new ApiError(409, 'Stop this bot’s response before editing it.');
    }
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    const updated = this.bots.save(
      {
        ...target,
        ...defined,
        ...(selection
          ? {
              ...selection,
              supportsImages: null,
              contextWindowTokens: null,
              maxOutputTokens: null,
              reasoningEffort:
                target.providerId === selection.providerId && target.model === selection.model
                  ? (target.reasoningEffort ?? null)
                  : null,
            }
          : {}),
      },
      target.id,
    );
    if (toolIds !== undefined) this.access.initializeChild(caller, updated, toolIds);
    return updated;
  }
  list(caller: Bot) {
    this.access.require(caller, 'manage_bot');
    return this.bots.list(caller.workspaceId).map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      createdBy: bot.createdBy,
      isMain: bot.isMain,
      hierarchyLevel: this.level(bot),
      ...this.providers.describeModel(bot),
    }));
  }
  listModels(caller: Bot) {
    this.requireAction(caller, 'list_models');
    return this.providers.listConfiguredModels();
  }
  getModel(caller: Bot, modelId: string) {
    this.requireAction(caller, 'get_model');
    return this.providers.getConfiguredModel(modelId);
  }
  async createFromTool(
    caller: Bot,
    input: Pick<
      z.infer<typeof botManagementDefinition.inputSchema>,
      'name' | 'role' | 'instructions' | 'toolIds' | 'modelId'
    >,
    signal: AbortSignal,
  ) {
    this.requireAction(caller, 'create');
    this.access.validateSelection(caller, input.toolIds);
    if (!input.name || !input.role?.trim() || !input.instructions)
      throw new ApiError(400, 'Create requires name, role, and instructions.');
    const current = this.bots.require(caller.id);
    const selection = input.modelId
      ? {
          ...this.providers.resolveModelSelection(input.modelId),
          supportsImages: null,
          contextWindowTokens: null,
          maxOutputTokens: null,
        }
      : {
          providerId: current.providerId,
          model: current.model,
          supportsImages: current.supportsImages,
          contextWindowTokens: current.contextWindowTokens,
          maxOutputTokens: current.maxOutputTokens,
        };
    const configuration = {
      name: input.name,
      role: input.role.trim(),
      instructions: input.instructions,
      ...selection,
    };
    await this.providers.testBotModel(configuration, signal);
    if (input.modelId) this.providers.resolveModelSelection(input.modelId);
    return this.create(current, configuration, input.toolIds, signal);
  }
  async create(
    caller: Bot,
    input: Omit<BotInput, 'avatar'>,
    toolIds?: string[],
    signal?: AbortSignal,
  ) {
    this.requireAction(caller, 'create');
    this.access.validateSelection(caller, toolIds);
    signal?.throwIfAborted();
    await this.providers.validateModel(input.providerId, input.model);
    signal?.throwIfAborted();
    return this.bots.save(
      { ...input, avatar: undefined },
      undefined,
      caller.workspaceId,
      caller.id,
      (child) => {
        this.access.require(caller, 'manage_bot');
        this.access.initializeChild(caller, child, toolIds);
      },
    );
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
      (!caller.isMain && target.isMain) ||
      this.level(target) < this.level(caller)
    )
      throw new ApiError(
        403,
        'You may message only peers or lower-level bots in this workspace’s hierarchy, never yourself or higher-level bots.',
      );
    return target;
  }
  getLastMessage(caller: Bot, botId: string, conversationId: string) {
    this.requireAction(caller, 'get_last_message');
    const target = this.requireMessageTarget(caller, botId);
    this.conversations.botChat(this.bots.require(caller.id), target, '', conversationId);
    const reply = this.conversations.latestBotReply(conversationId, target.id);
    return {
      botId: target.id,
      conversationId,
      requestId: reply?.requestId ?? null,
      messageId: reply?.id ?? null,
      status: reply?.status ?? 'empty',
      response: reply?.content.slice(-12000) ?? '',
      error: reply?.error ?? null,
    };
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
      onStarted: (value: NonNullable<ChatActivity['delegation']>) => void;
    },
    mode: 'fire_and_forget' | 'wait' = 'wait',
  ) {
    signal.throwIfAborted();
    this.requireAction(caller, 'send_message', delegation?.parentMessageId);
    const target = this.requireMessageTarget(caller, botId);
    caller = this.bots.require(caller.id);
    const saved = delegation?.parentMessageId
      ? this.jobs.delegation(delegation.parentMessageId, delegation.toolCallId)
      : undefined;
    if (
      saved &&
      (saved.callerId !== caller.id ||
        (saved.mode && saved.mode !== mode) ||
        saved.targetId !== target.id ||
        saved.message !== message ||
        (conversationId && conversationId !== saved.conversationId))
    )
      throw new ApiError(409, 'The saved bot request does not match this tool call.');
    if (saved?.state === 'cancelled')
      throw new ApiError(409, 'This bot request was cancelled. Send a new message to start again.');
    // A completed dispatch is replayed without resending or attaching a new wait.
    if (mode === 'fire_and_forget' && saved?.state === 'complete') {
      this.conversations.botChat(caller, target, '', saved.conversationId);
      const reply = this.conversations.latestBotReply(
        saved.conversationId,
        target.id,
        saved.childRequestId,
      );
      if (!reply)
        throw new ApiError(409, 'The original bot dispatch did not start. Send a new message.');
      return {
        botId: target.id,
        conversationId: saved.conversationId,
        requestId: saved.childRequestId,
        messageId: reply.id,
        status: reply.status,
        response: reply.content.slice(-12000),
        error: reply.error,
      };
    }
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
        mode,
      });
    delegation?.onStarted({
      botId: target.id,
      botName: target.name,
      conversationId: conversation.id,
      requestId,
      avatar: target.avatar,
      mode,
      status: 'streaming',
    });
    const abort = () => {
      if (this.chats.isClosing) return;
      if (delegation?.parentMessageId)
        this.jobs.delegationState(delegation.parentMessageId, delegation.toolCallId, 'cancelled');
      this.chats.stopConversation(conversation.id);
    };
    if (mode === 'wait') signal.addEventListener('abort', abort, { once: true });
    this.reserved.set(target.id, requestId);
    let response: ChatMessage | undefined;
    let started: ChatMessage | undefined;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const startup =
      mode === 'fire_and_forget'
        ? new Promise<void>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
          })
        : undefined;
    const run = async () => {
      try {
        await pausePursuitTask(() =>
          this.chats.respond(
            target,
            {
              requestId,
              text: message,
              attachmentIds: [],
            },
            {
              start() {},
              emit(event) {
                if (event.type === 'start') {
                  started = event.assistant;
                  resolveStarted?.();
                }
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
          ),
        );
        if (mode === 'wait') signal.throwIfAborted();
        if (!response) throw new ApiError(500, 'The bot did not return a saved response.');
        if (
          response.status !== 'streaming' &&
          !this.chats.isClosing &&
          delegation?.parentMessageId
        ) {
          const result: DelegationResult = {
            botId,
            conversationId: conversation.id,
            requestId,
            messageId: response.id,
            status: response.status,
            response: response.content.slice(-12000),
            error: response.error,
          };
          this.jobs.completeDelegation(delegation.parentMessageId, delegation.toolCallId, result);
          this.chats.delegationProgress(
            delegation.parentMessageId,
            delegation.toolCallId,
            undefined,
            result,
          );
        }
        if (mode === 'wait' && delegation?.parentMessageId)
          this.jobs.delegationState(delegation.parentMessageId, delegation.toolCallId, 'complete');
        return {
          botId,
          conversationId: conversation.id,
          requestId,
          messageId: response.id,
          status: response.status,
          response: response.content.slice(-12000),
          error: response.error,
        };
      } finally {
        this.reserved.delete(target.id);
        signal.removeEventListener('abort', abort);
      }
    };
    if (mode === 'fire_and_forget') {
      void outsidePursuitExecution(run).catch((error) => {
        rejectStarted(error);
        if (this.chats.isClosing || !delegation?.parentMessageId) return;
        const result: DelegationResult = {
          botId,
          conversationId: conversation.id,
          requestId,
          status: 'failed',
          response: '',
          error:
            error instanceof ApiError
              ? error.message
              : 'The delegated bot could not finish. Check its conversation for details.',
        };
        this.jobs.completeDelegation(delegation.parentMessageId, delegation.toolCallId, result);
        this.chats.delegationProgress(
          delegation.parentMessageId,
          delegation.toolCallId,
          undefined,
          result,
        );
      });
      await startup;
      return {
        botId,
        conversationId: conversation.id,
        requestId,
        messageId: started!.id,
        status: started!.status,
        response: started!.content.slice(-12000),
        error: started!.error,
      };
    }
    return run();
  }
  resumeBackground(caller: Bot, messageId: string, signal: AbortSignal) {
    for (const child of this.jobs.backgroundDelegations(messageId)) {
      if (child.result) continue;
      void this.sendMessage(
        caller,
        child.botId,
        child.message,
        signal,
        child.conversationId,
        {
          parentMessageId: messageId,
          toolCallId: child.toolCallId,
          onStarted: (info) => this.chats.delegationProgress(messageId, child.toolCallId, info),
        },
        'fire_and_forget',
      ).catch((error) => {
        if (signal.aborted || this.chats.isClosing) return;
        const result: DelegationResult = {
          botId: child.botId,
          conversationId: child.conversationId,
          requestId: child.requestId,
          status: 'failed',
          response: '',
          error:
            error instanceof ApiError ? error.message : 'The delegated bot could not be resumed.',
        };
        this.jobs.completeDelegation(messageId, child.toolCallId, result);
        this.chats.delegationProgress(messageId, child.toolCallId, undefined, result);
      });
    }
  }
}
