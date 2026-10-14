import { setTimeout as delay } from 'node:timers/promises';
import { TelegramApiError, type TelegramClient } from './client';

export class TelegramPoller {
  private controller = new AbortController();
  private running?: Promise<void>;
  constructor(
    private client: TelegramClient,
    private offset: () => number,
    private accept: (updates: unknown[]) => void,
    private status: (state: 'connecting' | 'polling' | 'error', error: string | null) => void,
  ) {}
  start() {
    this.running ??= this.run();
  }
  async stop() {
    this.controller.abort();
    await this.running;
  }
  private async run() {
    const signal = this.controller.signal;
    let failures = 0;
    this.status('connecting', null);
    while (!signal.aborted) {
      try {
        const updates = await this.client.call<unknown[]>(
          'getUpdates',
          {
            offset: this.offset(),
            timeout: 30,
            limit: 20,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        );
        if (!Array.isArray(updates)) throw new TelegramApiError(0);
        if (signal.aborted) break;
        this.accept(updates);
        this.status('polling', null);
        failures = 0;
        // Also prevents a broken proxy or fixture returning immediate empty polls spinning.
        await delay(100, undefined, { signal });
      } catch (error) {
        if (signal.aborted) break;
        const failure = error instanceof TelegramApiError ? error : new TelegramApiError(0);
        this.status('error', failure.message);
        if ([401, 403, 409].includes(failure.code)) break;
        failures++;
        await delay(
          Math.max(failure.retryAfter * 1000, Math.min(60000, 1000 * 2 ** Math.min(failures, 6))) +
            Math.random() * 250,
          undefined,
          { signal },
        ).catch(() => {});
      }
    }
  }
}
