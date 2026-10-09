import type { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { BotManagementService } from '../../services/botManagementService';
import { botManagementDefinition } from './definition';
export async function executeBotManagement(
  input: z.infer<typeof botManagementDefinition.inputSchema>,
  context: {
    bot: Bot;
    management: BotManagementService;
    signal: AbortSignal;
    messageId?: string;
    onActivity: (activity: ChatActivity) => void;
  },
  callId: string,
) {
  const activity: ChatActivity = {
    id: callId,
    tool: 'manage_bot',
    action: input.action,
    path: input.botId || input.name || '',
    status: 'running',
    summary: input.action === 'send_message' ? 'Sending a message to a bot…' : 'Managing bots…',
  };
  context.onActivity(activity);
  try {
    context.signal.throwIfAborted();
    context.management.requireAction(context.bot, input.action, context.messageId);
    let result;
    if (input.action === 'list') result = context.management.list(context.bot);
    else if (input.action === 'get') {
      if (!input.botId) throw new Error('get requires botId.');
      result = context.management.get(context.bot, input.botId);
    } else if (input.action === 'update') {
      if (!input.botId) throw new Error('update requires botId.');
      result = await context.management.update(context.bot, input.botId, {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        avatar: input.avatar,
        toolIds: input.toolIds,
      });
    } else if (input.action === 'create') {
      if (!input.name || !input.role?.trim() || !input.instructions)
        throw new Error('Create requires name, role, and instructions.');
      const caller = context.bot;
      result = await context.management.create(
        caller,
        {
          name: input.name,
          role: input.role.trim(),
          instructions: input.instructions,
          avatar: input.avatar || 'nova',
          providerId: caller.providerId,
          model: caller.model,
          supportsImages: caller.supportsImages,
          contextWindowTokens: caller.contextWindowTokens,
          maxOutputTokens: caller.maxOutputTokens,
        },
        input.toolIds,
      );
    } else {
      if (!input.botId || !input.message)
        throw new Error('send_message requires botId and message.');
      result = await context.management.sendMessage(
        context.bot,
        input.botId,
        input.message,
        context.signal,
        input.conversationId,
        {
          parentMessageId: context.messageId,
          toolCallId: callId,
          onStarted(value) {
            activity.delegation = value;
            activity.path = value.botName;
            activity.summary = `Waiting for ${value.botName}’s response…`;
            context.onActivity({ ...activity });
          },
        },
      );
    }
    context.onActivity({ ...activity, status: 'complete', summary: 'Bot operation completed.' });
    return { ok: true, result };
  } catch (error) {
    context.signal.throwIfAborted();
    const summary = error instanceof Error ? error.message : 'Bot operation failed.';
    context.onActivity({
      ...activity,
      status: context.signal.aborted ? 'interrupted' : 'failed',
      summary,
    });
    return { ok: false, error: summary };
  }
}
