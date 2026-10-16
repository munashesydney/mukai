import { tool } from 'ai';
import type { ChatActivity } from '../../../shared/ai';
import type { ConversationArtifactService } from '../../services/conversationArtifactService';
import type { ConversationHistoryService } from '../../services/conversationHistoryService';
import { conversationsDefinition } from './definition';
import { ToolFeedbackError } from '../../services/toolFeedback';

export function conversationTools(context: {
  history: ConversationHistoryService;
  artifacts?: ConversationArtifactService;
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
        try {
          const result =
            input.action === 'read_artifact'
              ? await context.artifacts!.read(context.workspaceId, input)
              : ['list_artifacts', 'search_artifacts'].includes(input.action)
                ? await context.artifacts!.list(context.workspaceId, input)
                : context.history.execute(context.workspaceId, input);
          context.onActivity({
            id: options.toolCallId,
            tool: 'conversations',
            action: input.action,
            path: input.action === 'read' ? input.conversationId! : input.query || '',
            status: 'complete',
            summary: `${result.results.length} results`,
          });
          return result;
        } catch (error) {
          if (!(error instanceof ToolFeedbackError)) throw error;
          context.onActivity({
            id: options.toolCallId,
            tool: 'conversations',
            action: input.action,
            path: input.attachmentId || input.artifactId || '',
            status: 'failed',
            summary: error.message,
          });
          return {
            ok: false as const,
            results: [],
            nextOffset: null,
            feedback: {
              code: error.code,
              message: error.message,
              ...(error.nextAction ? { nextAction: error.nextAction } : {}),
            },
          };
        }
      },
    }),
  };
}
