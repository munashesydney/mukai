import { expect, it, vi } from 'vitest';
import type { TelegramService } from '../services/telegramService';
import { TelegramClient } from './client';
import { TelegramDeliveryQueue } from './delivery';
import type { TelegramDelivery } from './types';
import { telegramMessage } from './presentation';

function setup(request: typeof fetch, overrides: Partial<TelegramDelivery> = {}) {
  const delivery: TelegramDelivery = {
    id: 'reply',
    connectionId: 'connection',
    chatId: 42,
    text: '**Hello**',
    attempts: 0,
    ...overrides,
  };
  const jobs = {
    delivery: vi.fn().mockReturnValueOnce(delivery),
    splitPending: vi.fn().mockReturnValue(false),
    sending: vi.fn(),
    delivered: vi.fn(),
    deliveryState: vi.fn(),
    queue: vi.fn(),
  };
  const service = {
    jobs,
    deliveryAllowed: vi.fn().mockReturnValue(true),
    messageText: vi.fn((text: string) => telegramMessage(text, 'Project', 'Scout')),
    loadMedia: vi.fn().mockResolvedValue({
      name: 'photo.png',
      bytes: Buffer.from('pixels'),
      mediaType: 'image/png',
    }),
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

const mediaDelivery = {
  workspaceId: 'workspace',
  botId: 'bot',
  replyTo: 7,
  media: { href: 'mukai://artifact/photo', label: 'Screenshot' },
};

it.each([
  ['image/png', 'sendPhoto', 'photo'],
  ['audio/mpeg', 'sendAudio', 'audio'],
  ['video/mp4', 'sendVideo', 'video'],
  ['application/pdf', 'sendDocument', 'document'],
])(
  'uploads %s with the original bytes, caption and reply target',
  async (mediaType, method, field) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: { message_id: 77 } }));
    const { queue, service, jobs } = setup(request, mediaDelivery);
    const bytes = Buffer.from('original-file-bytes');
    service.loadMedia.mockResolvedValue({ name: 'file', bytes, mediaType });
    try {
      queue.tick();
      await vi.waitFor(() => expect(jobs.delivered).toHaveBeenCalledWith('reply', 77));
      expect(String(request.mock.calls[0][0])).toMatch(new RegExp('/' + method + '$'));
      const form = request.mock.calls[0][1]!.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('caption')).toBe('Workspace Project\nBot Scout\n\nScreenshot');
      expect(JSON.parse(String(form.get('reply_parameters')))).toMatchObject({ message_id: 7 });
      expect(Buffer.from(await (form.get(field) as Blob).arrayBuffer())).toEqual(bytes);
      expect(request.mock.calls[0][1]!.headers).toBeUndefined();
    } finally {
      await queue.stop();
    }
  },
);

it('falls back to a document only after a confirmed native-media rejection', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ok: false, error_code: 400 }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 78 } }));
  const { queue, jobs } = setup(request, mediaDelivery);
  try {
    queue.tick();
    await vi.waitFor(() => expect(jobs.delivered).toHaveBeenCalledWith('reply', 78));
    expect(request.mock.calls.map((call) => String(call[0]).split('/').at(-1))).toEqual([
      'sendPhoto',
      'sendDocument',
    ]);
    expect((request.mock.calls[1][1]!.body as FormData).get('document')).toBeInstanceOf(Blob);
  } finally {
    await queue.stop();
  }
});

it.each(['network', 'server'])(
  'does not fall back or retry an uncertain %s media send',
  async (failure) => {
    const request = vi.fn<typeof fetch>();
    if (failure === 'network') request.mockRejectedValue(new Error('Lost response'));
    else request.mockResolvedValue(Response.json({ ok: false, error_code: 500 }, { status: 500 }));
    const { queue, jobs } = setup(request, mediaDelivery);
    try {
      queue.tick();
      await vi.waitFor(() => expect(jobs.deliveryState).toHaveBeenCalledWith('reply', 'uncertain'));
      expect(request).toHaveBeenCalledOnce();
      expect(jobs.queue).not.toHaveBeenCalled();
    } finally {
      await queue.stop();
    }
  },
);

it('reschedules a rate-limited upload without sending a document fallback', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 5 } },
        { status: 429 },
      ),
    );
  const { queue, jobs } = setup(request, mediaDelivery);
  try {
    queue.tick();
    await vi.waitFor(() =>
      expect(jobs.deliveryState).toHaveBeenCalledWith('reply', 'pending', expect.any(Number)),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(jobs.queue).not.toHaveBeenCalled();
  } finally {
    await queue.stop();
  }
});

it('reports an unavailable file without marking an unsent upload uncertain', async () => {
  const request = vi.fn<typeof fetch>();
  const { queue, service, jobs } = setup(request, mediaDelivery);
  service.loadMedia.mockRejectedValue(new Error('sensitive private file details'));
  try {
    queue.tick();
    await vi.waitFor(() => expect(jobs.deliveryState).toHaveBeenCalledWith('reply', 'failed'));
    expect(request).not.toHaveBeenCalled();
    expect(jobs.sending).not.toHaveBeenCalled();
    expect(jobs.queue).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Could not deliver “Screenshot”') }),
      'reply:notice',
    );
    expect(JSON.stringify(jobs.queue.mock.calls)).not.toContain('sensitive');
  } finally {
    await queue.stop();
  }
});

it('cancels a media upload when workspace access changes during loading', async () => {
  const request = vi.fn<typeof fetch>();
  const { queue, service, jobs } = setup(request, mediaDelivery);
  service.loadMedia.mockImplementation(async () => {
    service.deliveryAllowed.mockReturnValue(false);
    return { name: 'photo.png', bytes: Buffer.from('pixels'), mediaType: 'image/png' };
  });
  try {
    queue.tick();
    await vi.waitFor(() => expect(jobs.deliveryState).toHaveBeenCalledWith('reply', 'cancelled'));
    expect(request).not.toHaveBeenCalled();
    expect(jobs.queue).not.toHaveBeenCalled();
  } finally {
    await queue.stop();
  }
});

it('leaves an unsent file pending when shutdown interrupts loading', async () => {
  const request = vi.fn<typeof fetch>();
  const { queue, service, jobs } = setup(request, mediaDelivery);
  service.loadMedia.mockImplementation(
    (_delivery: TelegramDelivery, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Aborted'))),
      ),
  );
  queue.tick();
  await vi.waitFor(() => expect(service.loadMedia).toHaveBeenCalledOnce());
  await queue.stop();
  expect(request).not.toHaveBeenCalled();
  expect(jobs.sending).not.toHaveBeenCalled();
  expect(jobs.deliveryState).not.toHaveBeenCalled();
  expect(jobs.queue).not.toHaveBeenCalled();
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
