import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import sharp from 'sharp';
import { tool, type ToolSet } from 'ai';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
import { resultPreview } from '../../services/toolResultPolicy';
import { imageDefinition, type ImageInput } from './definition';
import { artifactHref, attachmentHref } from '../../../shared/responseReferences';

const FILE_LIMIT = 10 * 1024 * 1024;
const PIXEL_LIMIT = 40_000_000;
const OUTPUT_LIMIT = 10 * 1024 * 1024;
export type ImageSource = (input: {
  attachmentId?: string;
  artifactId?: string;
}) => Promise<{ bytes: Buffer; name: string }>;
type ImageContext = RuntimeToolContext & {
  folder: string | null;
  vision: boolean;
  readImage?: ImageSource;
};

export function executeImage(input: ImageInput, context: ImageContext, callId: string) {
  let sourceName = input.path || input.attachmentId || input.artifactId || '';
  const runtime = {
    ...context,
    onActivity: (activity: Parameters<ImageContext['onActivity']>[0]) =>
      context.onActivity({
        ...activity,
        path: sourceName,
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      }),
  };
  return executeRuntime(runtime, callId, 'image', input.action, sourceName, async () => {
    imageDefinition.inputSchema.parse(input);
    if (input.action === 'view' && !context.vision)
      throw new Error(
        'The current model has image input disabled. A vision model is required for pixel delivery; no image pixels were delivered.',
      );
    let bytes: Buffer;
    let path: string | undefined;
    if (input.attachmentId || input.artifactId) {
      if (!context.readImage)
        throw new Error('Saved image references are unavailable in this context.');
      const source = await context.readImage(input);
      bytes = source.bytes;
      sourceName = source.name;
      if (!bytes.length || bytes.length > FILE_LIMIT)
        throw new Error('The image is empty or exceeds the 10 MiB limit.');
    } else {
      if (!input.path) throw new Error('No image path was supplied.');
      if (input.path.includes('\0')) throw new Error('The image path contains a null character.');
      if (!isAbsolute(input.path) && !context.folder)
        throw new Error(
          'A relative image path requires a workspace folder; an absolute path does not.',
        );
      path = isAbsolute(input.path) ? resolve(input.path) : resolve(context.folder!, input.path);
      const file = await open(path, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size < 1 || info.size > FILE_LIMIT)
          throw new Error('The source is not a regular image file between 1 byte and 10 MiB.');
        // Bound the read even if the file grows between stat and read.
        const buffer = Buffer.alloc(Math.min(info.size + 1, FILE_LIMIT + 1));
        let length = 0;
        while (length < buffer.length) {
          context.signal.throwIfAborted();
          const chunk = await file.read(buffer, length, buffer.length - length, null);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > info.size || length > FILE_LIMIT)
          throw new Error('The image changed while reading or exceeds the 10 MiB limit. ');
        bytes = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
    }
    context.signal.throwIfAborted();
    const decoder = sharp(bytes, { limitInputPixels: PIXEL_LIMIT, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if (
      !['png', 'jpeg', 'webp'].includes(metadata.format || '') ||
      !metadata.width ||
      !metadata.height
    )
      throw new Error('The image format is not supported; PNG, JPEG and WebP are accepted.');
    if ((metadata.pages || 1) > 1) throw new Error('Animated images are unsupported.');
    const pipeline = decoder.rotate();
    if (input.detail !== 'original')
      pipeline.resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
    // Decode even for read, so metadata alone cannot validate corrupt image data.
    // Normalization strips metadata and provides a PNG header for context costing.
    const normalized = await pipeline.png().toBuffer({ resolveWithObject: true });
    context.signal.throwIfAborted();
    if (normalized.data.length > OUTPUT_LIMIT)
      throw new Error('The decoded image exceeds the 10 MiB output limit.');
    return {
      reference: input.artifactId
        ? artifactHref(input.artifactId)
        : input.attachmentId
          ? attachmentHref(input.attachmentId)
          : `mukai://file/${encodeURIComponent(input.path!)}`,
      ...(path
        ? { path }
        : {
            name: sourceName,
            ...(input.attachmentId
              ? { attachmentId: input.attachmentId }
              : { artifactId: input.artifactId }),
          }),
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      bytes: bytes.length,
      viewed: input.action === 'view',
      ...(input.action === 'view'
        ? {
            image: normalized.data.toString('base64'),
            mediaType: 'image/png' as const,
            outputWidth: normalized.info.width,
            outputHeight: normalized.info.height,
            imageIncluded: false,
            imageDelivery: 'pending',
          }
        : {}),
    };
  });
}

export function imageTools(context: ImageContext): ToolSet {
  return {
    image: tool({
      description: imageDefinition.description,
      inputSchema: imageDefinition.inputSchema,
      execute: (input, options) =>
        executeImage(
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
        // Rejected invocations bypass execute but still use this converter.
        const value = output as { result?: { image?: string } };
        if (value.result?.image) {
          const { image, ...metadata } = value.result;
          return {
            type: 'content',
            value: [
              {
                type: 'text',
                text: resultPreview(
                  {
                    ...output,
                    result: { ...metadata, imageIncluded: true, imageDelivery: 'included' },
                  },
                  context.resultBytes ?? 96000,
                ),
              },
              { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
            ],
          };
        }
        return { type: 'text', value: resultPreview(output, context.resultBytes ?? 96000) };
      },
    }),
  };
}
