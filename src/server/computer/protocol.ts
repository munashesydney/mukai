import { z } from 'zod';
import type { RuntimeOwner } from '../../shared/runtime';
import { ApiError } from '../config';

export const PROTOCOL_VERSION = 1;
export const GUEST_REVISION = 18;
export const FRAME_LIMIT = 24 * 1024 * 1024;
export const methods = [
  'terminal',
  'process',
  'files',
  'image',
  'media',
  'browser',
  'download',
  'computer_use',
  'capability',
] as const;
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
export const guestResponse = z.object({
  id: z.string().uuid(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorStatus: z.number().int().min(400).max(599).optional(),
});
export function encodeGuestError(error: unknown, fallback: string) {
  return {
    error: error instanceof Error ? error.message : fallback,
    ...(error instanceof ApiError ? { errorStatus: error.status } : {}),
  };
}
export function decodeGuestError(reply: { error?: string; errorStatus?: number }) {
  const message = reply.error || 'Guest request failed.';
  return reply.errorStatus ? new ApiError(reply.errorStatus, message) : new Error(message);
}
export type ComputerHelper = (action: string, args: unknown[]) => Promise<unknown>;
export const helperRequest = z.object({
  requestId: z.string().uuid(),
  rpcId: z.string().uuid(),
  action: z.enum(['enqueue', 'wakeBot', 'callRoute', 'terminal_started']),
  args: z.array(z.unknown()).max(3),
});
export const helperReply = z
  .object({
    requestId: z.string().uuid(),
    rpcId: z.string().uuid(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();
export interface Computer {
  request(
    method: ComputerMethod,
    input: unknown,
    owner: RuntimeOwner,
    signal: AbortSignal,
    helper?: ComputerHelper,
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
