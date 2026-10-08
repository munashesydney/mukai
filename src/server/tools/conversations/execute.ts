import { tool } from 'ai';
import type { ChatActivity } from '../../../shared/ai';
import type { ConversationHistoryService } from '../../services/conversationHistoryService';
import { conversationsDefinition } from './definition';

export function conversationTools(context: {
  history: ConversationHistoryService;
  workspaceId: string;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  return {
    conversations: tool({
      description: conversationsDefinition.description,
      inputSchema: conversationsDefinition.inputSchema,
      execute: async (input, options) => {
        context.signal.throwIfAborted();
        options.abortSignal?.throwIfAborted();
        const result = context.history.execute(context.workspaceId, input);
        context.onActivity({
          id: options.toolCallId,
          tool: 'conversations',
          action: input.action,
          path: input.action === 'read' ? input.conversationId! : input.query || '',
          status: 'complete',
          summary: `${result.results.length} results`,
        });
        return result;
      },
    }),
  };
}
