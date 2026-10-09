import { tool, type ToolSet } from 'ai';
import type { ComputerUseService } from '../../services/computerUseService';
import type { Computer } from '../../computer/protocol';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
import { resultPreview } from '../../services/toolResultPolicy';
import { computerUseDefinition, validateComputerUse, type ComputerUseInput } from './definition';

export interface ComputerUseContext extends RuntimeToolContext {
  desktop: Pick<ComputerUseService, 'execute'> | Computer;
  vision: boolean;
  saveScreenshot(
    image: string,
  ): Promise<{ artifactId: string; path: string; width: number; height: number }>;
}
export function executeComputerUse(
  input: ComputerUseInput,
  context: ComputerUseContext,
  callId: string,
) {
  return executeRuntime(
    context,
    callId,
    'computer_use',
    input.action,
    input.displayId || '',
    async () => {
      validateComputerUse(computerUseDefinition.inputSchema.parse(input));
      const result =
        'request' in context.desktop
          ? await context.desktop.request('computer_use', input, context.owner, context.signal)
          : await context.desktop.execute(context.owner, input, context.signal);
      if (
        input.action === 'screenshot' &&
        result &&
        typeof result === 'object' &&
        'image' in result &&
        typeof result.image === 'string'
      ) {
        const saved = await context.saveScreenshot(result.image);
        return {
          ...result,
          ...saved,
          ...('path' in result && typeof result.path === 'string' ? { path: result.path } : {}),
          screenshotUrl: '/artifacts/' + saved.artifactId,
          imageIncluded: false,
          imageDelivery: 'pending',
        };
      }
      return result;
    },
  );
}
export function computerUseTools(context: ComputerUseContext): ToolSet {
  return {
    computer_use: tool({
      description: computerUseDefinition.description,
      inputSchema: computerUseDefinition.inputSchema,
      execute: (input, options) =>
        executeComputerUse(
          input,
          {
            ...context,
            signal: options.abortSignal
              ? AbortSignal.any([context.signal, options.abortSignal])
              : context.signal,
          },
          options.toolCallId,
        ),
      toModelOutput: ({ output }) => {
        const value = output.result;
        if (
          value &&
          typeof value === 'object' &&
          'image' in value &&
          typeof value.image === 'string'
        ) {
          const { image, ...metadata } = value;
          const text = resultPreview(
            {
              ...output,
              result: {
                ...metadata,
                imageIncluded: context.vision,
                imageDelivery: context.vision ? 'included' : 'unsupported',
                ...(!context.vision
                  ? { notice: 'Choose a vision model to inspect the saved screenshot pixels.' }
                  : {}),
              },
            },
            context.resultBytes ?? 96000,
          );
          if (context.vision)
            return {
              type: 'content',
              value: [
                { type: 'text', text },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
              ],
            };
          return { type: 'text', value: text };
        }
        return { type: 'text', value: resultPreview(output, context.resultBytes ?? 96000) };
      },
    }),
  };
}
