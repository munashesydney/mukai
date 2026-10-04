import { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { PursuitService } from '../../services/pursuitService';
import { pursuitActionSchema, pursuitDefinition } from './definition';

export function executePursuit(
  input: z.infer<typeof pursuitDefinition.inputSchema>,
  context: {
    bot: Bot;
    pursuits: PursuitService;
    onActivity: (activity: ChatActivity) => void;
    signal: AbortSignal;
    scheduledRun: boolean;
  },
  callId: string,
) {
  const activity: ChatActivity = {
    id: callId,
    tool: pursuitDefinition.name,
    action: input.action,
    path: input.pursuitId || '',
    status: 'running',
    summary: 'Managing pursuit…',
  };
  context.onActivity(activity);
  try {
    context.signal.throwIfAborted();
    const value = pursuitActionSchema.parse(input);
    const { pursuits, bot } = context;
    if (value.action === 'create' && context.scheduledRun)
      throw new Error('Scheduled runs cannot create additional pursuits.');
    const result =
      value.action === 'list'
        ? pursuits.forBot(bot)
        : value.action === 'create'
          ? pursuits.create(bot, value)
          : value.action === 'update'
            ? pursuits.updateOwned(bot, value.pursuitId, value)
            : pursuits.controlOwned(
                bot,
                value.pursuitId,
                value.action === 'pause'
                  ? 'paused'
                  : value.action === 'complete'
                    ? 'completed'
                    : 'active',
              );
    context.onActivity({
      ...activity,
      path: !Array.isArray(result) ? result.name : activity.path,
      status: 'complete',
      summary: `Pursuit ${input.action} completed.`,
    });
    return { ok: true, result };
  } catch (error) {
    const summary =
      error instanceof z.ZodError
        ? 'Invalid pursuit arguments. Create and update require name, objective, and successCriteria. Update, pause, resume, and complete require a valid pursuitId. Correct the arguments and retry.'
        : error instanceof Error
          ? error.message
          : 'Pursuit operation failed.';
    context.onActivity({ ...activity, status: 'failed', summary });
    return { ok: false, error: summary };
  }
}
