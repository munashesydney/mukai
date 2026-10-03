import { tool } from 'ai';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { MemoryService } from '../../services/memoryService';
import { executeRuntime } from '../runtimeContext';
import { memoryAddDefinition, memorySearchDefinition, memoryForgetDefinition } from './definition';

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
    budget: { remaining: 12 },
  };
  return {
    memory_add: tool({
      description: memoryAddDefinition.description,
      inputSchema: memoryAddDefinition.inputSchema,
      execute: (input, options) =>
        executeRuntime(runtime, options.toolCallId, 'memory_add', 'add', input.scope, () =>
          context.memory.add(
            context.bot,
            context.conversationId,
            context.messageId,
            input.content,
            input.scope === 'workspace',
            `tool:${context.messageId}:${options.toolCallId}`,
            context.signal,
          ),
        ),
    }),
    memory_search: tool({
      description: memorySearchDefinition.description,
      inputSchema: memorySearchDefinition.inputSchema,
      execute: (input, options) =>
        executeRuntime(runtime, options.toolCallId, 'memory_search', 'search', input.query, () =>
          context.memory.search(context.bot, context.conversationId, input.query, input),
        ),
    }),
    memory_forget: tool({
      description: memoryForgetDefinition.description,
      inputSchema: memoryForgetDefinition.inputSchema,
      execute: (input, options) =>
        executeRuntime(
          runtime,
          options.toolCallId,
          'memory_forget',
          'forget',
          input.memoryId,
          () => {
            context.memory.engine.forgetMemory(
              context.memory.scope(context.bot, context.conversationId),
              input.memoryId,
            );
            return { forgotten: true };
          },
        ),
    }),
  };
}
