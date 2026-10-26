import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Computer } from './protocol';
import type { RuntimeToolContext } from '../tools/runtimeContext';
import { executeRuntime } from '../tools/runtimeContext';
import { terminalDefinition, processDefinition } from '../tools/terminal/definition';
import { fileOperationsDefinition } from '../tools/file-operations/definition';
import { browserDefinition } from '../tools/browser/definition';
import type { ImageSource } from '../tools/image/execute';
import { executeMedia, mediaModelOutput } from '../tools/media/execute';
import { mediaDefinition } from '../tools/media/definition';
import { resultPreview } from '../services/toolResultPolicy';
import type { FileMutationSnapshot } from '../../shared/fileChanges';
import { computerUseTools } from '../tools/computer_use/execute';
import { artifactHref, type SavedFileReference } from '../../shared/responseReferences';
import { terminalSnapshotSchema, missingEnvironmentError } from '../../shared/terminal';

export function computerTools(
  context: RuntimeToolContext & {
    computer: Computer;
    vision: boolean;
    supportsAudio?: boolean;
    supportsVideo?: boolean;
    readImage?: ImageSource;
    attachmentBytes?: (id: string) => Promise<Buffer>;
    fileBudget: { remaining: number };
    recordChange(snapshot: FileMutationSnapshot): void;
    recordFile(
      path: string,
      metadata?: import('../../shared/fileMetadata').FileMetadata,
    ): SavedFileReference | void;
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
    mediaDefinition,
  ];
  for (const definition of definitions) {
    const name = definition.name;
    const description =
      name === 'terminal'
        ? 'Run a Linux /bin/sh command inside this workspace’s VM, in /home/mukai/workspace. cwd is relative to that directory. Each call starts a fresh non-interactive shell without a PTY. envFromSettings selects workspace variable names from Settings for this run and its child processes; missing or empty names fail before launch. env is for ordinary nonsecret values. Use process for background sessions, stdin, logs, waiting and termination. Commands never execute on the host.'
        : name === 'browser'
          ? browserDefinition.description +
            ' In this VM workspace, all targets use Chrome inside the Linux guest, visible in View computer. mukai is an alias for chrome here (there is no embedded guest browser). chrome-default uses the guest desktop’s main Chrome profile and its logins, never the host browser. Enable and approve main Chrome connections inside the VM. Stopping the VM ends all guest browser sessions. screenshot artifacts use guest paths.'
          : name === 'media'
            ? mediaDefinition.description +
              ' Paths refer to the Linux guest, relative to /home/mukai/workspace. IDs reopen saved uploads or artifacts without copying them into the VM.'
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
        if (name === 'media' && (value.attachmentId || value.artifactId))
          return executeMedia(
            mediaDefinition.inputSchema.parse(input),
            { ...runtime, folder: null, vision: context.vision },
            options.toolCallId,
          );
        return executeRuntime(
          runtime,
          options.toolCallId,
          name === 'process' ? 'terminal' : name,
          String(value.action || 'run'),
          String(value.path || value.command || value.sessionId || value.url || ''),
          async () => {
            if (name === 'media') {
              const capability =
                value.action === 'view_image'
                  ? context.vision
                  : value.action === 'listen_audio'
                    ? context.supportsAudio
                    : value.action === 'view_video'
                      ? context.supportsVideo
                      : true;
              if (!capability)
                throw new Error(
                  `The current model has ${value.action === 'listen_audio' ? 'audio' : value.action === 'view_video' ? 'video' : 'image'} input disabled. No media content was delivered.`,
                );
            }
            const method =
              name === 'file_operations'
                ? 'files'
                : (name as 'terminal' | 'process' | 'browser' | 'media');
            let requestInput = input;
            if (name === 'terminal') {
              const terminal = terminalDefinition.inputSchema.parse(input);
              const names = terminal.envFromSettings || [];
              if (names.length && !context.resolveTerminalEnvironment)
                throw new Error(missingEnvironmentError(names));
              const settingsEnvironment = names.length
                ? context.resolveTerminalEnvironment!(names)
                : {};
              requestInput = names.length ? { ...terminal, settingsEnvironment } : terminal;
            }
            if (name === 'file_operations' && value.action === 'copy_attachment') {
              if (
                typeof value.attachmentId !== 'string' ||
                typeof value.path !== 'string' ||
                !context.attachmentBytes
              )
                throw new Error('copy_attachment requires attachmentId and destination path.');
              const bytes = await context.attachmentBytes(value.attachmentId);
              requestInput = { ...value, bytes: bytes.toString('base64') };
            }
            const result = await context.computer.request(
              method,
              requestInput,
              context.owner,
              signal,
              name === 'terminal'
                ? async (action, args) => {
                    if (action !== 'terminal_started') throw new Error('Unknown terminal event.');
                    const snapshot = terminalSnapshotSchema.parse(args[0]);
                    context.onActivity({
                      id: options.toolCallId,
                      tool: 'terminal',
                      action: 'run',
                      path: String(value.command || ''),
                      status: 'running',
                      summary: '',
                      processSessionId: snapshot.id,
                      terminal: snapshot,
                    });
                    return null;
                  }
                : undefined,
            );
            if (name === 'file_operations') {
              const response = z
                .object({
                  result: z
                    .object({
                      path: z.string(),
                      changed: z.boolean().optional(),
                      metadata: z
                        .object({ mediaType: z.string(), size: z.number().int().nonnegative() })
                        .optional(),
                    })
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
              let reference: SavedFileReference | void = undefined;
              try {
                for (const snapshot of response.changes) context.recordChange(snapshot);
                if (response.result.changed) {
                  if (value.action !== 'copy_attachment')
                    reference = context.recordFile(response.result.path, response.result.metadata);
                  else if (typeof response.result.artifactPath === 'string')
                    reference = context.recordFile(
                      response.result.artifactPath,
                      response.result.metadata,
                    );
                }
              } catch {
                warnings.push(
                  'The guest file was saved, but its history or artifact could not be recorded.',
                );
              }
              return { ...response.result, ...reference, warnings };
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
                reference: artifactHref(saved.artifactId),
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
        if (name === 'media') return mediaModelOutput(result, context.resultBytes);
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
