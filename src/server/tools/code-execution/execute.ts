import { tool } from 'ai';
import type { ChatActivity } from '../../../shared/ai';
import { codeExecutionDefinition } from './definition';
import { CodeExecutionRuntime, type CodeToolBridge } from './runtime';

export function codeExecutionTools(context: {
  runtime: CodeExecutionRuntime;
  bridge: CodeToolBridge;
  signal: AbortSignal;
  onActivity(activity: ChatActivity): void;
  budget: { remaining: number };
}) {
  return {
    execute_code: tool({
      description: codeExecutionDefinition.description,
      inputSchema: codeExecutionDefinition.inputSchema,
      execute: async (input, options) => {
        const signal = options.abortSignal
          ? AbortSignal.any([context.signal, options.abortSignal])
          : context.signal;
        signal.throwIfAborted();
        if (--context.budget.remaining < 0)
          throw new Error('Code execution call budget reached. Summarize completed work.');
        const activity: ChatActivity = {
          id: options.toolCallId,
          tool: 'execute_code',
          action: 'execute',
          path: 'JavaScript',
          status: 'running',
          summary: '',
        };
        context.onActivity(activity);
        try {
          const result = await context.runtime.run(
            input.code,
            input.timeoutMs ?? 30000,
            options.toolCallId,
            signal,
            context.bridge,
          );
          context.onActivity({
            ...activity,
            status:
              result.status === 'interrupted' ? 'interrupted' : result.ok ? 'complete' : 'failed',
            summary: result.output + (result.error ? '\n' + result.error : ''),
          });
          return result;
        } catch (error) {
          context.onActivity({
            ...activity,
            status: signal.aborted ? 'interrupted' : 'failed',
            summary: error instanceof Error ? error.message : 'Code execution failed.',
          });
          throw error;
        }
      },
    }),
  };
}
