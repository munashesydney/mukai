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
    path: input.botId || input.modelId || input.name || '',
    status: 'running',
    summary: input.action === 'send_message' ? 'Sending a message to a bot…' : 'Managing bots…',
  };
  context.onActivity(activity);
  try {
    context.signal.throwIfAborted();
    context.management.requireAction(context.bot, input.action, context.messageId);
    let result;
    if (input.action === 'list_models') result = context.management.listModels(context.bot);
    else if (input.action === 'get_model') {
      if (!input.modelId) throw new Error('get_model requires modelId from list_models.');
      result = context.management.getModel(context.bot, input.modelId);
    } else if (input.action === 'list') result = context.management.list(context.bot);
    else if (input.action === 'get') {
      if (!input.botId) throw new Error('get requires botId.');
      result = context.management.get(context.bot, input.botId);
    } else if (input.action === 'delete') {
      if (!input.botId) throw new Error('delete requires botId.');
      result = context.management.remove(context.bot, input.botId);
    } else if (input.action === 'update') {
      if (!input.botId) throw new Error('update requires botId.');
      result = await context.management.update(
        context.bot,
        input.botId,
        {
          name: input.name,
          role: input.role,
          instructions: input.instructions,
          toolIds: input.toolIds,
          modelId: input.modelId,
        },
        context.signal,
      );
    } else if (input.action === 'create') {
      if (!input.name || !input.role?.trim() || !input.instructions)
        throw new Error('Create requires name, role, and instructions.');
      result = await context.management.createFromTool(context.bot, input, context.signal);
      activity.createdBotId = result.id;
    } else if (input.action === 'get_last_message') {
      if (!input.botId || !input.conversationId)
        throw new Error('get_last_message requires botId and conversationId.');
      result = context.management.getLastMessage(context.bot, input.botId, input.conversationId);
    } else {
      if (!input.botId || !input.message || !input.mode)
        throw new Error(
          'send_message requires botId, message, and mode (fire_and_forget or wait).',
        );
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
            activity.summary =
              input.mode === 'wait'
                ? `Waiting for ${value.botName}’s response…`
                : `Starting work for ${value.botName}…`;
            context.onActivity({ ...activity });
          },
        },
        input.mode,
      );
    }
    context.onActivity({ ...activity, status: 'complete', summary: 'Bot operation completed.' });
    if (input.action === 'create' || input.action === 'update' || input.action === 'get')
      result = context.management.describe(result as Bot);
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
