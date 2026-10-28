import { z } from 'zod';
import { ApiError } from '../config';
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_DOWNLOAD_LIMIT } from '../../shared/artifacts';
import type { Computer } from './protocol';
import type { RuntimeOwner } from '../../shared/runtime';

const chunkSchema = z.object({
  name: z.string().min(1).max(4000),
  bytes: z.string().max(Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4),
  offset: z.number().int().nonnegative(),
  size: z.number().int().min(0).max(ARTIFACT_DOWNLOAD_LIMIT),
  version: z.string().min(1).max(200),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** Keep each base64 reply below the VM frame limit while fetching a larger UI file. */
export async function downloadGuestFile(
  computer: Computer,
  path: string,
  owner: RuntimeOwner,
  signal: AbortSignal,
  maxBytes: number,
) {
  const request = async (input: unknown) => {
    try {
      return await computer.request('download', input, owner, signal);
    } catch (error) {
      if (error instanceof Error && !(error instanceof ApiError)) {
        let oldGuestLimit = false;
        try {
          const issues: unknown = JSON.parse(error.message);
          oldGuestLimit =
            Array.isArray(issues) &&
            issues.some(
              (issue) =>
                issue?.code === 'too_big' &&
                issue.maximum === 10 * 1024 * 1024 &&
                Array.isArray(issue.path) &&
                issue.path.length === 1 &&
                issue.path[0] === 'maxBytes',
            );
        } catch {
          /* Older guests serialize schema failures as text. */
        }
        if (oldGuestLimit)
          throw new ApiError(
            409,
            'Restart the workspace VM to apply large-file preview support, then open this file again.',
          );
      }
      if (
        error instanceof Error &&
        !(error instanceof ApiError) &&
        [
          'This artifact is unavailable or exceeds the file limit.',
          'This artifact exceeds the file limit.',
        ].includes(error.message)
      )
        throw new ApiError(
          400,
          'This file is unavailable or exceeds this VM’s file limit. Restart the workspace VM to apply large-file support, then try again.',
        );
      throw error;
    }
  };
  if (maxBytes <= 10 * 1024 * 1024) {
    const result = (await request({ path, maxBytes })) as { name: string; bytes: string };
    return { name: result.name, bytes: Buffer.from(result.bytes, 'base64') };
  }
  let offset = 0;
  let version: string | undefined;
  let name = '';
  let bytes: Buffer | undefined;
  while (true) {
    signal.throwIfAborted();
    const raw = await request({
      path,
      maxBytes,
      offset,
      length: ARTIFACT_CHUNK_BYTES,
      ...(version ? { version } : {}),
    });
    signal.throwIfAborted();
    const parsed = chunkSchema.safeParse(raw);
    if (!parsed.success)
      throw new ApiError(
        502,
        'The workspace VM returned incomplete file data. Restart the VM to apply its latest update, then try again.',
      );
    const chunk = parsed.data;
    const part = Buffer.from(chunk.bytes, 'base64');
    const end = offset + part.length;
    if (
      chunk.size > maxBytes ||
      chunk.offset !== offset ||
      part.toString('base64') !== chunk.bytes ||
      part.length !== Math.min(ARTIFACT_CHUNK_BYTES, chunk.size - offset) ||
      chunk.nextOffset !== (end < chunk.size ? end : null)
    )
      throw new ApiError(502, 'The workspace VM returned incomplete file data. Try again.');
    if (bytes && (chunk.version !== version || chunk.size !== bytes.length || chunk.name !== name))
      throw new ApiError(
        409,
        'This file changed while it was being read. Wait for it to finish writing, then try again.',
      );
    if (!bytes) {
      bytes = Buffer.alloc(chunk.size);
      version = chunk.version;
      name = chunk.name;
    }
    part.copy(bytes, offset);
    if (chunk.nextOffset === null) return { name, bytes };
    offset = end;
  }
}
