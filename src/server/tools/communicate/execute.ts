import { tool } from 'ai';
import type { ChatActivity } from '../../../shared/ai';
import type { AskHandler } from '../ask/execute';
import { communicateDefinition } from './definition';
import { askDefinition } from '../ask/definition';

export function communicateTools(context: {
  ask: AskHandler;
  notify: (input: { title: string; message: string }, toolCallId: string) => unknown;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
}) {
  return {
    communicate: tool({
      description: communicateDefinition.description,
      inputSchema: communicateDefinition.inputSchema,
      execute: async (input, options) => {
        const signal = options.abortSignal
          ? AbortSignal.any([context.signal, options.abortSignal])
          : context.signal;
        signal.throwIfAborted();
        if (input.action === 'notify') {
          const result = context.notify(
            { title: input.title!, message: input.message! },
            options.toolCallId,
          );
          context.onActivity({
            id: options.toolCallId,
            tool: 'communicate',
            action: 'notify',
            path: input.title!,
            status: 'complete',
            summary: input.message!,
          });
          return result;
        }
        const question = askDefinition.inputSchema.parse({
          action: input.action,
          question: input.question,
          options: input.options,
        });
        const result = await context.ask(question, options.toolCallId, signal);
        context.onActivity({
          id: options.toolCallId,
          tool: 'communicate',
          action: input.action,
          path: question.question.slice(0, 120),
          status: 'complete',
          summary: `${input.question}\n\n${result.action === 'clarification' ? 'User answer: ' + result.answer : result.approved ? 'Approved by the user.' : 'Denied by the user. The proposed action is not authorized.' + (result.reason ? '\nReason: ' + result.reason : '')}`,
        });
        return result;
      },
    }),
  };
}
