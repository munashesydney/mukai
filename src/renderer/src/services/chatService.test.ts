import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatMessage } from '../../../shared/ai';
import { chatService } from './chatService';

const input = { requestId: 'request-id', text: 'Hello', attachmentIds: [] };
const message: ChatMessage = {
  id: 'assistant-id',
  requestId: input.requestId,
  botId: 'scout',
  role: 'assistant',
  content: 'Hello 🌱',
  status: 'complete',
  error: null,
  createdAt: '2026-10-01T00:00:00Z',
  attachments: [],
};
beforeEach(() => vi.stubGlobal('window', {}));
afterEach(() => vi.unstubAllGlobals());

describe('Chat service stream transport', () => {
  it('decodes split UTF-8 and split event lines, including a final line without a newline', async () => {
    const events: ChatEvent[] = [
      { type: 'delta', id: message.id, text: message.content },
      { type: 'done', message },
    ];
    const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join('\n'));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                // Single-byte chunks split both JSON lines and the emoji's UTF-8 sequence.
                for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
                controller.close();
              },
            }),
          ),
      ),
    );
    const received: ChatEvent[] = [];
    await chatService.stream('scout', input, (event) => received.push(event));
    expect(received).toEqual(events);
  });
  it('reports a stream that ends without a final event as interrupted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: 'delta', id: message.id, text: 'Partial reply' }) + '\n',
          ),
      ),
    );
    await expect(chatService.stream('scout', input, () => {})).rejects.toThrow('interrupted');
  });
  it('cancels and unlocks the stream if an event cannot be parsed', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('invalid json\n'));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    await expect(chatService.stream('scout', input, () => {})).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
