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
    conversationId?: string;
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
    let result: unknown;
    switch (value.action) {
      case 'list':
        result = pursuits.forBot(bot);
        break;
      case 'create':
        result = pursuits.create(bot, value);
        break;
      case 'update':
        result = pursuits.updateOwned(bot, value.pursuitId, value);
        break;
      case 'delete':
        result = pursuits.removeOwned(bot, value.pursuitId);
        break;
      case 'list_entries': {
        const page = pursuits.listEntriesOwned(bot, value.pursuitId, {
          type: value.type,
          status: value.status,
          includeArchived: value.includeArchived,
          limit: value.limit,
          offset: value.offset,
        });
        result = {
          ...page,
          entries: page.entries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            title: entry.title,
            status: entry.status,
            revision: entry.revision,
            updatedAt: entry.updatedAt,
            contentPreview: entry.content.slice(0, 240),
            contentTruncated: entry.content.length > 240,
            linkCount: entry.links.length,
          })),
          retrieval:
            'Use get_entry with pursuitId and entryId for full content, links, and provenance.',
        };
        break;
      }
      case 'get_entry':
        result = pursuits.getEntryOwned(bot, value.pursuitId, value.entryId);
        break;
      case 'add_entry':
        result = pursuits.addEntryOwned(bot, value.pursuitId, value.entry, context.conversationId);
        break;
      case 'update_entry':
        result = pursuits.updateEntryOwned(
          bot,
          value.pursuitId,
          value.entryId,
          value.patch,
          value.expectedRevision,
          context.conversationId,
        );
        break;
      default:
        result = pursuits.controlOwned(
          bot,
          value.pursuitId,
          value.action === 'pause'
            ? 'paused'
            : value.action === 'complete'
              ? 'completed'
              : 'active',
        );
    }
    context.onActivity({
      ...activity,
      path:
        result && typeof result === 'object' && 'name' in result && typeof result.name === 'string'
          ? result.name
          : activity.path,
      status: 'complete',
      summary: `Pursuit ${input.action} completed.`,
    });
    return { ok: true, result };
  } catch (error) {
    const summary =
      error instanceof z.ZodError
        ? 'Invalid pursuit arguments: ' +
          error.issues
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; ')
        : error instanceof Error
          ? error.message
          : 'Pursuit operation failed.';
    context.onActivity({ ...activity, status: 'failed', summary });
    return { ok: false, error: summary };
  }
}
