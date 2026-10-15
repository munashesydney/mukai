import { afterEach, expect, it, vi } from 'vitest';
import { TelegramApiError, TelegramClient } from './client';
import { TelegramPoller } from './poller';
import { splitTelegramText } from './commands';
import { TelegramChatOutput } from './chatOutput';
import type { TelegramJob } from './types';
import type { TelegramDeliveryQueue } from './delivery';

afterEach(() => vi.useRealTimers());
const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM';

it('pins Telegram HTTPS, forbids redirects, and never propagates credential-bearing fetch errors', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error(`fetch failed https://api.telegram.org/bot${token}/getMe`));
  const client = new TelegramClient(token, transport);
  await expect(client.identity()).rejects.toThrow('Could not reach Telegram');
  try {
    await client.call('sendMessage', { chat_id: 1, text: 'hello' });
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).uncertain).toBe(true);
    expect(String(error)).not.toContain(token);
    expect((error as Error).cause).toBeUndefined();
  }
  expect(transport.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
  expect(transport.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(transport.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});

it('honors retry_after without exposing upstream descriptions and bounds response bodies', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { ok: false, error_code: 429, description: token, parameters: { retry_after: 7 } },
        { status: 429 },
      ),
    )
    .mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
  const client = new TelegramClient(token, transport);
  await expect(client.call('sendMessage', {})).rejects.toMatchObject({
    code: 429,
    retryAfter: 7,
    uncertain: false,
  });
  await expect(client.call('getUpdates', {})).rejects.toMatchObject({ code: 0 });
});

it('does not spin on a terminal polling conflict and aborts long polls on shutdown', async () => {
  const failed = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ok: false, error_code: 409 }, { status: 409 }));
  const status = vi.fn();
  const poller = new TelegramPoller(new TelegramClient(token, failed), () => 5, vi.fn(), status);
  poller.start();
  await vi.waitFor(() =>
    expect(status).toHaveBeenLastCalledWith('error', expect.stringContaining('Another poller')),
  );
  await poller.stop();
  expect(failed).toHaveBeenCalledTimes(1);
  let aborted = false;
  const held: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  const waiting = new TelegramPoller(new TelegramClient(token, held), () => 0, vi.fn(), vi.fn());
  waiting.start();
  await waiting.stop();
  expect(aborted).toBe(true);
});

it('splits long replies without corrupting emoji or losing text', () => {
  const text = 'a'.repeat(4095) + '🌱' + '\n' + 'b'.repeat(5000);
  const parts = splitTelegramText(text);
  expect(parts.join('')).toBe(text);
  expect(parts.every((part) => part.length <= 4096)).toBe(true);
  expect(parts.some((part) => /[\uD800-\uDBFF]$/.test(part))).toBe(false);
});

it('streams text only, keeping reasoning, tools, and approval payloads local', () => {
  const draft = vi.fn(),
    end = vi.fn(),
    approval = vi.fn();
  const job = { id: 'request', sequence: 1 } as TelegramJob;
  const delivery = { draft, end } as unknown as TelegramDeliveryQueue;
  const output = new TelegramChatOutput(job, delivery, approval);
  output.start();
  output.emit({ type: 'delta', id: 'answer', text: 'Hello', partId: 'text-1' });
  output.emit({ type: 'reasoning', id: 'answer', text: 'private reasoning' });
  output.emit({ type: 'approval', id: 'sensitive-approval-id' });
  expect(draft.mock.calls.map((call) => call[1])).toEqual(['', 'Hello', '']);
  expect(approval).toHaveBeenCalledOnce();
  expect(JSON.stringify(draft.mock.calls)).not.toContain('private reasoning');
});
