import { open } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { executeImage, type ImageSource } from '../image/execute';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
import { mediaAttachment } from '../../services/mediaAttachment';
import { resultPreview } from '../../services/toolResultPolicy';
import { artifactHref, attachmentHref } from '../../../shared/responseReferences';
import { mediaDefinition, type MediaInput } from './definition';

export type MediaContext = RuntimeToolContext & {
  folder: string | null;
  vision: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  readImage?: ImageSource;
  readMedia?: ImageSource;
};
const LIMIT = 10 * 1024 * 1024;

async function source(input: MediaInput, context: MediaContext) {
  if (input.attachmentId || input.artifactId) {
    const read = context.readMedia || context.readImage;
    if (!read) throw new Error('Saved media references are unavailable in this context.');
    const value = await read(input);
    if (!value.bytes.length || value.bytes.length > LIMIT)
      throw new Error('The media file is empty or exceeds the 10 MiB limit.');
    return value;
  }
  if (!input.path || input.path.includes('\0')) throw new Error('The media path is invalid.');
  if (!isAbsolute(input.path) && !context.folder)
    throw new Error(
      'A relative media path cannot be resolved because this workspace has no folder.',
    );
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(context.folder!, input.path);
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > LIMIT)
      throw new Error('The source is not a regular media file between 1 byte and 10 MiB.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, LIMIT + 1));
    let length = 0;
    while (length < buffer.length) {
      context.signal.throwIfAborted();
      const chunk = await file.read(buffer, length, buffer.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > stat.size || length > LIMIT)
      throw new Error('The media file grew while reading or exceeds the 10 MiB limit.');
    return { bytes: buffer.subarray(0, length), name: path, path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTDIR'].includes(code || ''))
      throw new Error('The requested media file no longer exists at this path.');
    if (['EACCES', 'EPERM'].includes(code || ''))
      throw new Error('The requested media file could not be read because access was denied.');
    throw error;
  } finally {
    await file?.close();
  }
}

export async function executeMedia(input: MediaInput, context: MediaContext, callId: string) {
  if (input.action.endsWith('_image'))
    return executeImage(
      { ...input, action: input.action === 'view_image' ? 'view' : 'read' },
      {
        ...context,
        readImage: context.readMedia || context.readImage,
        onActivity: (activity) =>
          context.onActivity({ ...activity, tool: 'media', action: input.action }),
      },
      callId,
    );
  let name = input.path || input.attachmentId || input.artifactId || '';
  const runtime = {
    ...context,
    onActivity: (activity: Parameters<MediaContext['onActivity']>[0]) =>
      context.onActivity({
        ...activity,
        path: name,
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      }),
  };
  return executeRuntime(runtime, callId, 'media', input.action, name, async () => {
    mediaDefinition.inputSchema.parse(input);
    const audio = input.action.endsWith('_audio');
    const inspect = input.action === 'listen_audio' || input.action === 'view_video';
    if (inspect && !(audio ? context.supportsAudio : context.supportsVideo))
      throw new Error(
        `The current model has ${audio ? 'audio' : 'video'} input disabled. No media content was delivered.`,
      );
    const value = await source(input, context);
    name = value.name;
    context.signal.throwIfAborted();
    const extension = audio
      ? value.bytes.toString('ascii', 0, 4) === 'RIFF'
        ? '.wav'
        : '.mp3'
      : extname(value.name).toLowerCase() === '.mov' ||
          value.bytes.toString('ascii', 8, 12) === 'qt  '
        ? '.mov'
        : '.mp4';
    let metadata: ReturnType<typeof mediaAttachment>;
    try {
      metadata = mediaAttachment(extension, value.bytes);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message.split('. ')[0] + '.'
          : 'The media container could not be read.',
      );
    }
    const reference = input.attachmentId
      ? attachmentHref(input.attachmentId)
      : input.artifactId
        ? artifactHref(input.artifactId)
        : `mukai://file/${encodeURIComponent(input.path!)}`;
    return {
      reference,
      ...('path' in value ? { path: value.path } : { name }),
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...metadata,
      format: extension.slice(1),
      bytes: value.bytes.length,
      inspected: inspect,
      mediaIncluded: false,
      mediaDelivery: inspect ? 'pending' : 'metadata_only',
      ...(inspect ? { media: value.bytes.toString('base64') } : {}),
    };
  });
}

export function mediaModelOutput(output: unknown, bytes = 96000) {
  const value = output as { result?: Record<string, unknown> };
  const result = value.result;
  if (result && (typeof result.media === 'string' || typeof result.image === 'string')) {
    const { media, image, ...metadata } = result;
    const isImage = typeof image === 'string';
    return {
      type: 'content' as const,
      value: [
        {
          type: 'text' as const,
          text: resultPreview(
            {
              ...value,
              result: {
                ...metadata,
                ...(isImage
                  ? { imageIncluded: true, imageDelivery: 'included' }
                  : { mediaIncluded: true, mediaDelivery: 'included' }),
              },
            },
            bytes,
          ),
        },
        {
          type: 'file' as const,
          mediaType: String(metadata.mediaType),
          data: { type: 'data' as const, data: (isImage ? image : media) as string },
        },
      ],
    };
  }
  return { type: 'text' as const, value: resultPreview(output, bytes) };
}

export function mediaTools(context: MediaContext): ToolSet {
  return {
    media: tool({
      description: mediaDefinition.description,
      inputSchema: mediaDefinition.inputSchema,
      execute: (input, options) =>
        executeMedia(
          input,
          {
            ...context,
            signal: options.abortSignal
              ? AbortSignal.any([context.signal, options.abortSignal])
              : context.signal,
          },
          options.toolCallId,
        ),
      toModelOutput: ({ output }) => mediaModelOutput(output, context.resultBytes),
    }),
  };
}
