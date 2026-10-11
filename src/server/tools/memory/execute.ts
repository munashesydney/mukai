import { tool } from 'ai';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { MemoryService } from '../../services/memoryService';
import { executeRuntime } from '../runtimeContext';
import { memoryDefinition } from './definition';
import { RUNTIME_TOOL_CALL_LIMIT } from '../../services/responsePolicy';

export function memoryTools(context: {
  bot: Bot;
  conversationId: string;
  messageId: string;
  memory: MemoryService;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  const runtime = {
    ...context,
    owner: {
      workspaceId: context.bot.workspaceId,
      botId: context.bot.id,
      conversationId: context.conversationId,
    },
    budget: { remaining: RUNTIME_TOOL_CALL_LIMIT },
  };
  return {
    memory: tool({
      description: memoryDefinition.description,
      inputSchema: memoryDefinition.inputSchema,
      execute: (input, options) =>
        executeRuntime(
          runtime,
          options.toolCallId,
          'memory',
          input.action,
          input.action === 'add'
            ? 'workspace'
            : input.action === 'search'
              ? input.query || ''
              : input.memoryId || '',
          async () => {
            switch (input.action) {
              case 'add':
                if (!input.content) throw new Error('Memory add requires content.');
                return context.memory.add(
                  context.bot,
                  context.conversationId,
                  context.messageId,
                  input.content,
                  `tool:${context.messageId}:${options.toolCallId}`,
                  context.signal,
                );
              case 'search':
                if (!input.query) throw new Error('Memory search requires query.');
                return context.memory.search(context.bot, input.query, {
                  limit: input.limit,
                  asOf: input.asOf,
                  includeHistory: input.includeHistory,
                });
              case 'forget':
                if (!input.memoryId)
                  throw new Error('Memory forget requires memoryId from search.');
                context.memory.engine.forgetMemory(
                  context.memory.scope(context.bot),
                  input.memoryId,
                );
                return { forgotten: true };
            }
          },
        ),
    }),
  };
}
