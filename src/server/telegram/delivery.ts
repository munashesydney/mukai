import { TelegramApiError, type TelegramClient } from './client';
import type { TelegramService } from '../services/telegramService';
import type { TelegramJob } from './types';

interface Draft {
  job: TelegramJob;
  text: string;
  sent: string;
  refreshedAt: number;
  draftId: number;
}
export class TelegramDeliveryQueue {
  private controller = new AbortController();
  private active?: Promise<void>;
  private nextAt = 0;
  private drafts = new Map<string, Draft>();
  private callbacks = new Map<string, number>();
  private draftsSupported = true;
  private stopped = false;
  private blocked = false;
  constructor(
    private service: TelegramService,
    private client: TelegramClient,
  ) {}
  draft(job: TelegramJob, text: string) {
    if (this.stopped) return;
    const previous = this.drafts.get(job.id);
    let tail = text.slice(-4000);
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    this.drafts.set(job.id, {
      job,
      text: tail,
      sent: previous?.sent ?? '',
      refreshedAt: previous?.refreshedAt ?? 0,
      draftId: previous?.draftId ?? job.sequence + 1,
    });
  }
  end(jobId: string) {
    this.drafts.delete(jobId);
  }
  acknowledge(id: string, chatId: number) {
    if (this.callbacks.size < 100) this.callbacks.set(id, chatId);
  }
  tick() {
    if (this.stopped || this.blocked || this.active || Date.now() < this.nextAt) return;
    this.active = this.flush()
      .catch(() => {
        this.service.reportDeliveryError(
          'Telegram delivery paused after an unexpected error. Pause and resume the connection to try again.',
        );
        this.blocked = true;
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async stop() {
    this.stopped = true;
    this.controller.abort();
    this.drafts.clear();
    this.callbacks.clear();
    await this.active;
  }
  private async flush() {
    const signal = this.controller.signal,
      jobs = this.service.jobs;
    const callback = this.callbacks.entries().next().value;
    if (callback) {
      this.callbacks.delete(callback[0]);
      const connection = this.service.connection();
      if (!connection || !this.service.targetAllowed(connection.id, callback[1])) return;
      try {
        await this.client.call('answerCallbackQuery', { callback_query_id: callback[0] }, signal);
      } catch {
        /* Expired callback acknowledgments do not affect chat delivery. */
      }
      return;
    }
    const delivery = jobs.delivery(Date.now());
    if (delivery) {
      if (!this.service.deliveryAllowed(delivery)) {
        jobs.deliveryState(delivery.id, 'cancelled');
        return;
      }
      jobs.sending(delivery.id);
      this.nextAt = Date.now() + 1100;
      try {
        const result = await this.client.call<{ message_id: number }>(
          'sendMessage',
          {
            chat_id: delivery.chatId,
            text: delivery.text,
            ...(delivery.markup ? { reply_markup: delivery.markup } : {}),
            ...(delivery.replyTo
              ? {
                  reply_parameters: {
                    message_id: delivery.replyTo,
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        if (!Number.isSafeInteger(result?.message_id)) {
          jobs.deliveryState(delivery.id, 'uncertain');
          this.service.reportDeliveryError(
            'Telegram did not confirm reply delivery. Check Telegram before sending another request.',
          );
          return;
        }
        jobs.delivered(delivery.id, result.message_id);
      } catch (error) {
        const failure =
          error instanceof TelegramApiError ? error : new TelegramApiError(0, 0, true);
        if (failure.uncertain) jobs.deliveryState(delivery.id, 'uncertain');
        else if (failure.code === 429 && delivery.attempts < 10) {
          this.nextAt = Date.now() + Math.max(1000, failure.retryAfter * 1000);
          jobs.deliveryState(delivery.id, 'pending', this.nextAt);
        } else jobs.deliveryState(delivery.id, 'failed');
        if ([401, 403, 409].includes(failure.code)) this.blocked = true;
        if (!this.stopped)
          this.service.reportDeliveryError(
            failure.uncertain
              ? 'Telegram did not confirm reply delivery. Check Telegram before sending another request.'
              : failure.code === 403
                ? 'Telegram access was denied. Unblock your bot in Telegram, then pause and resume this connection in Mukai.'
                : failure.message,
          );
      }
      return;
    }
    for (const [id, draft] of this.drafts) {
      if (!this.service.jobAllowed(draft.job)) {
        this.drafts.delete(id);
        continue;
      }
      const refreshMs = this.draftsSupported ? 15000 : 4000;
      if (
        (!this.draftsSupported || draft.text === draft.sent) &&
        Date.now() - draft.refreshedAt < refreshMs
      )
        continue;
      this.nextAt = Date.now() + 1100;
      draft.sent = draft.text;
      draft.refreshedAt = Date.now();
      try {
        await this.client.call(
          this.draftsSupported ? 'sendMessageDraft' : 'sendChatAction',
          this.draftsSupported
            ? { chat_id: draft.job.chatId, draft_id: draft.draftId, text: draft.text }
            : { chat_id: draft.job.chatId, action: 'typing' },
          signal,
        );
      } catch (error) {
        const failure = error instanceof TelegramApiError ? error : new TelegramApiError(0);
        if ([400, 404].includes(failure.code)) this.draftsSupported = false;
        if (failure.code === 429)
          this.nextAt = Date.now() + Math.max(1000, failure.retryAfter * 1000);
      }
      this.drafts.delete(id);
      this.drafts.set(id, draft);
      break;
    }
  }
}
