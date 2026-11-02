import { tool } from 'ai';
import { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { EnvironmentVariable } from '../../../shared/customCapabilities';
import type { CapabilityEnvironment } from '../../capabilities/environment';
import { RUNTIME_TOOL_CALL_LIMIT } from '../../services/responsePolicy';
import { executeRuntime } from '../runtimeContext';
import { systemDefinition, type SystemInput } from './definition';

export const ENV_VAR_PAGE_DEFAULT = 25;
export const ENV_VAR_PAGE_MAX = 100;

export interface EnvironmentVariablePage {
  total: number;
  matched: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  variables: EnvironmentVariable[];
}

/**
 * Filters and pages names only. Ordering is whatever the environment service
 * returns (sorted by name), so paging stays stable across calls.
 */
export function listEnvironmentVariables(
  variables: EnvironmentVariable[],
  input: { query?: string; limit?: number; offset?: number },
): EnvironmentVariablePage {
  const needle = input.query?.trim().toLowerCase();
  const matched = needle
    ? variables.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.usedBy.some((user) => user.toLowerCase().includes(needle)),
      )
    : variables;
  const limit = Math.min(Math.max(input.limit ?? ENV_VAR_PAGE_DEFAULT, 1), ENV_VAR_PAGE_MAX);
  const offset = Math.max(input.offset ?? 0, 0);
  const page = matched.slice(offset, offset + limit);
  const consumed = offset + page.length;
  return {
    total: variables.length,
    matched: matched.length,
    limit,
    offset,
    nextOffset: page.length && consumed < matched.length ? consumed : null,
    variables: page,
  };
}

export function systemTools(context: {
  bot: Bot;
  conversationId: string;
  environment?: CapabilityEnvironment;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  const actions: SystemInput['action'][] = context.environment
    ? ['list_env_vars', 'stop_generation']
    : ['stop_generation'];
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
    [systemDefinition.name]: tool({
      description: context.environment
        ? systemDefinition.description
        : 'stop_generation explicitly ends only this response, without another model generation. Call it by itself when you intentionally finish, including after a reasoning/text echo nudge. Optional finalResponse supplies the final answer; otherwise the latest visible text is preserved. Completed work is saved. Newer user guidance and required outcome reporting take priority. Environment access is unavailable in this tool.',
      inputSchema: systemDefinition.inputSchema.safeExtend({
        action: z.enum(actions),
      }),
      execute: (input, options) =>
        executeRuntime(
          runtime,
          options.toolCallId,
          'system',
          input.action,
          input.action === 'stop_generation' ? 'current response' : input.query || 'environment',
          async () => {
            switch (input.action) {
              case 'list_env_vars':
                if (!context.environment)
                  throw new Error('Workspace environment variables are unavailable.');
                return listEnvironmentVariables(
                  context.environment.list(context.bot.workspaceId),
                  input,
                );
              case 'stop_generation':
                return {
                  stopGeneration: true,
                  ...(input.finalResponse ? { finalResponse: input.finalResponse } : {}),
                };
            }
          },
        ),
    }),
  };
}
