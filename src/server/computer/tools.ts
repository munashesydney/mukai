import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Computer } from './protocol';
import type { RuntimeToolContext } from '../tools/runtimeContext';
import { executeRuntime } from '../tools/runtimeContext';
import { terminalDefinition, processDefinition } from '../tools/terminal/definition';
import { fileOperationsDefinition } from '../tools/file-operations/definition';
import { browserDefinition } from '../tools/browser/definition';
import { imageDefinition } from '../tools/image/definition';
import { resultPreview } from '../services/toolResultPolicy';
import type { FileMutationSnapshot } from '../../shared/fileChanges';
import { computerUseTools } from '../tools/computer_use/execute';

export function computerTools(
  context: RuntimeToolContext & {
    computer: Computer;
    vision: boolean;
    fileBudget: { remaining: number };
    recordChange(snapshot: FileMutationSnapshot): void;
    recordFile(path: string): void;
    saveScreenshot(
      image: string,
    ): Promise<{ artifactId: string; path: string; width: number; height: number }>;
  },
): ToolSet {
  const output: ToolSet = computerUseTools({ ...context, desktop: context.computer });
  const definitions = [
    terminalDefinition,
    processDefinition,
    fileOperationsDefinition,
    browserDefinition,
    imageDefinition,
  ];
  for (const definition of definitions) {
    const name = definition.name;
    const description =
      name === 'terminal'
        ? 'Run a Linux /bin/sh command inside this workspace’s VM, in /home/mukai/workspace. cwd is relative to that directory. Each call starts a fresh non-interactive shell without a PTY. Use process for background sessions, stdin, logs, waiting and termination. Commands never execute on the host.'
        : name === 'browser'
          ? browserDefinition.description +
            ' In this VM workspace, all targets use Chrome inside the Linux guest, visible in View computer. mukai is an alias for chrome here (there is no embedded guest browser). chrome-default uses the guest desktop’s main Chrome profile and its logins, never the host browser. Enable and approve main Chrome connections inside the VM. Stopping the VM ends all guest browser sessions. screenshot artifacts use guest paths.'
          : name === 'image'
            ? 'Read or view a PNG/JPEG/WebP inside the Linux VM. Absolute paths refer to the guest; relative paths resolve under /home/mukai/workspace. view requires a vision model. Limits: 10 MiB, 40 million pixels.'
            : definition.description;
    output[name] = tool({
      description,
      inputSchema: definition.inputSchema as z.ZodType<Record<string, unknown>>,
      execute: async (input, options) => {
        const value = input as Record<string, unknown>;
        const signal = options.abortSignal
          ? AbortSignal.any([context.signal, options.abortSignal])
          : context.signal;
        const runtime = {
          ...context,
          signal,
          budget: name === 'file_operations' ? context.fileBudget : context.budget,
        };
        return executeRuntime(
          runtime,
          options.toolCallId,
          name === 'process' ? 'terminal' : name,
          String(value.action || 'run'),
          String(value.path || value.command || value.sessionId || value.url || ''),
          async () => {
            if (name === 'image' && value.action === 'view' && !context.vision)
              throw new Error('Choose a vision model to view images.');
            const method =
              name === 'file_operations'
                ? 'files'
                : (name as 'terminal' | 'process' | 'browser' | 'image');
            const result = await context.computer.request(method, input, context.owner, signal);
            if (name === 'file_operations') {
              const response = z
                .object({
                  result: z
                    .object({ path: z.string(), changed: z.boolean().optional() })
                    .passthrough(),
                  changes: z.array(
                    z.object({
                      path: z.string(),
                      before: z.string().nullable(),
                      after: z.string(),
                    }),
                  ),
                })
                .parse(result);
              const warnings: string[] = [];
              try {
                for (const snapshot of response.changes) context.recordChange(snapshot);
                if (response.result.changed) context.recordFile(response.result.path);
              } catch {
                warnings.push(
                  'The guest file was saved, but its history or artifact could not be recorded.',
                );
              }
              return { ...response.result, warnings };
            }
            if (name === 'browser' && value.action === 'screenshot') {
              const screenshot = z
                .object({ image: z.string(), path: z.string() })
                .passthrough()
                .parse(result);
              const saved = await context.saveScreenshot(screenshot.image);
              return {
                ...screenshot,
                artifactId: saved.artifactId,
                width: saved.width,
                height: saved.height,
                screenshotUrl: '/artifacts/' + saved.artifactId,
                imageIncluded: false,
                imageDelivery: 'pending',
              };
            }
            return result;
          },
        );
      },
      toModelOutput: ({ output: result }) => {
        const value = result as { result?: Record<string, unknown> };
        const picture = value.result;
        if (picture && typeof picture.image === 'string') {
          const { image, ...metadata } = picture;
          const text = resultPreview(
            {
              ...value,
              result: {
                ...metadata,
                imageIncluded: context.vision,
                imageDelivery: context.vision ? 'included' : 'unsupported',
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
        return { type: 'text', value: resultPreview(result, context.resultBytes ?? 96000) };
      },
    });
  }
  return output;
}
