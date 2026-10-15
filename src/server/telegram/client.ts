import { z } from 'zod';
import { userSchema } from './types';

/** Contains only locally authored messages, never Telegram descriptions or credential URLs. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
    readonly uncertain = false,
  ) {
    super(
      code === 401
        ? 'Telegram rejected the bot token. Reconnect with a current BotFather token.'
        : code === 409
          ? 'Another poller or webhook is using this bot. Stop it before reconnecting.'
          : code === 429
            ? 'Telegram is rate limiting requests. Mukai will wait and retry.'
            : code === 403
              ? 'Telegram access was denied. Check that the bot is not blocked.'
              : code === 400
                ? 'Telegram could not accept this request.'
                : 'Could not reach Telegram. Mukai will reconnect automatically.',
    );
  }
}
export class TelegramClient {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  async call<T>(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!/^[a-zA-Z]+$/.test(method)) throw new Error('Invalid Telegram method.');
    const controller = AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000);
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([signal, controller]) : controller,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) throw new Error('Response too large.');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (!response.ok || result.ok !== true) {
        const retry = Number(result.parameters?.retry_after);
        throw new TelegramApiError(
          result.error_code || response.status,
          Number.isFinite(retry) ? Math.max(1, Math.min(retry, 86400)) : 0,
          response.status >= 500 && method === 'sendMessage',
        );
      }
      return result.result as T;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      // Fetch errors can embed the token URL in their causes. Never propagate them.
      throw new TelegramApiError(0, 0, method === 'sendMessage');
    }
  }
  async identity(signal?: AbortSignal) {
    const result = await this.call('getMe', {}, signal);
    return userSchema
      .extend({ is_bot: z.literal(true), username: z.string().regex(/^[A-Za-z0-9_]{5,64}$/) })
      .parse(result);
  }
}
