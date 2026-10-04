import { tool } from 'ai';
import type { AskInput, AskResponse } from '../../../shared/ask';
import type { ChatActivity } from '../../../shared/ai';
import { askDefinition } from './definition';

export type AskHandler = (
  input: AskInput,
  toolCallId: string,
  signal: AbortSignal,
) => Promise<AskResponse>;

export function askTools(context: {
  ask: AskHandler;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  return {
    ask: tool({
      description: askDefinition.description,
      inputSchema: askDefinition.inputSchema,
      execute: async (input, options) => {
        const signal = options.abortSignal
          ? AbortSignal.any([context.signal, options.abortSignal])
          : context.signal;
        const result = await context.ask(input, options.toolCallId, signal);
        context.onActivity({
          id: options.toolCallId,
          tool: 'ask',
          action: input.action,
          path: input.question.slice(0, 120),
          status: 'complete',
          summary: `${input.question}\n\n${result.action === 'clarification' ? 'User answer: ' + result.answer : result.approved ? 'Approved by the user.' : 'Denied by the user. The proposed action is not authorized.'}`,
        });
        return result;
      },
    }),
  };
}
