import { z } from 'zod';
import type { RuntimeOwner } from '../../shared/runtime';

export const PROTOCOL_VERSION = 1;
export const GUEST_REVISION = 7;
export const FRAME_LIMIT = 24 * 1024 * 1024;
export const methods = ['terminal', 'process', 'files', 'image', 'browser', 'download'] as const;
export const guestRequest = z.object({
  id: z.string().uuid(),
  method: z.enum(methods),
  owner: z.object({
    workspaceId: z.string().min(1),
    botId: z.string().min(1),
    conversationId: z.string().min(1),
  }),
  input: z.unknown(),
});
export type ComputerMethod = (typeof methods)[number];
export interface Computer {
  request(
    method: ComputerMethod,
    input: unknown,
    owner: RuntimeOwner,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Byte-bounded newline framing; Buffer handles UTF-8 split across reads. */
export class Frames {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > FRAME_LIMIT) throw new Error('Computer response exceeds the frame limit.');
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length) messages.push(JSON.parse(line.toString('utf8')));
    }
    if (this.buffer.length > FRAME_LIMIT)
      throw new Error('Computer response exceeds the frame limit.');
    return messages;
  }
}
export function encodeFrame(value: unknown) {
  const frame = Buffer.from(JSON.stringify(value) + '\n');
  if (frame.length > FRAME_LIMIT) throw new Error('Computer request exceeds the frame limit.');
  return frame;
}
