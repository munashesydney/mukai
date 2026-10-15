import { expect, it, vi } from 'vitest';
import type { TelegramService } from '../services/telegramService';
import { TelegramClient } from './client';
import { TelegramDeliveryQueue } from './delivery';

function setup(request: typeof fetch) {
  const delivery = {
    id: 'reply',
    connectionId: 'connection',
    chatId: 42,
    text: '**Hello**',
    attempts: 0,
  };
  const jobs = {
    delivery: vi.fn().mockReturnValueOnce(delivery),
    splitPending: vi.fn().mockReturnValue(false),
    sending: vi.fn(),
    delivered: vi.fn(),
    deliveryState: vi.fn(),
  };
  const service = {
    jobs,
    deliveryAllowed: vi.fn().mockReturnValue(true),
    messageText: vi.fn().mockReturnValue('Workspace Project\nBot Scout\n\n**Hello**'),
    reportDeliveryError: vi.fn(),
  };
  return {
    jobs,
    service,
    queue: new TelegramDeliveryQueue(
      service as unknown as TelegramService,
      new TelegramClient('token', request),
    ),
  };
}

it('retries a confirmed formatting rejection as plain text, retaining the original content', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ok: false, error_code: 400 }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 77 } }));
  const { queue, jobs } = setup(request);
  try {
    queue.tick();
    await vi.waitFor(() => expect(jobs.delivered).toHaveBeenCalledWith('reply', 77));
    const payloads = request.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(payloads[0]).toMatchObject({
      text: 'Workspace Project\nBot Scout\n\nHello',
      entities: [
        { type: 'bold', offset: 10, length: 7 },
        { type: 'bold', offset: 22, length: 5 },
        { type: 'bold', offset: 29, length: 5 },
      ],
    });
    expect(payloads[1]).toMatchObject({ text: 'Workspace Project\nBot Scout\n\n**Hello**' });
    expect(payloads[1]).not.toHaveProperty('entities');
  } finally {
    await queue.stop();
  }
});

it('never retries an uncertain formatted send, which could duplicate the message', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('Connection lost'));
  const { queue, jobs } = setup(request);
  try {
    queue.tick();
    await vi.waitFor(() => expect(jobs.deliveryState).toHaveBeenCalledWith('reply', 'uncertain'));
    expect(request).toHaveBeenCalledOnce();
    expect(jobs.delivered).not.toHaveBeenCalled();
  } finally {
    await queue.stop();
  }
});
