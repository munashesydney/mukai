import { TelegramApiError, type TelegramClient } from './client';
import type { TelegramService } from '../services/telegramService';
import type { TelegramDelivery, TelegramJob, TelegramMediaFile } from './types';
import { telegramFormatting } from './formatting';
import { telegramMediaField, telegramMediaLabel, telegramMediaMethod } from './media';

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
  private lastWasDraft = false;
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
    let delivery = jobs.delivery(Date.now());
    if (
      delivery &&
      (delivery.priority ?? 0) >= 2 &&
      !this.lastWasDraft &&
      [...this.drafts.values()].some((draft) => draft.text && draft.text !== draft.sent)
    )
      delivery = undefined;
    if (delivery) {
      this.lastWasDraft = false;
      if (!this.service.deliveryAllowed(delivery)) {
        jobs.deliveryState(delivery.id, 'cancelled');
        return;
      }
      if (jobs.splitPending(delivery)) return;
      let file: TelegramMediaFile | undefined;
      if (delivery.media) {
        try {
          file = await this.service.loadMedia(delivery, signal);
        } catch {
          // A read/download failure happened before a Telegram send, so it cannot be uncertain.
          if (this.stopped) return;
          if (!this.service.deliveryAllowed(delivery)) {
            jobs.deliveryState(delivery.id, 'cancelled');
            return;
          }
          jobs.deliveryState(delivery.id, 'failed');
          this.mediaNotice(delivery);
          return;
        }
        // Access may have been revoked while bytes were being loaded.
        if (this.stopped) return;
        if (!this.service.deliveryAllowed(delivery)) {
          jobs.deliveryState(delivery.id, 'cancelled');
          return;
        }
      }
      jobs.sending(delivery.id);
      this.nextAt = Date.now() + 1100;
      try {
        const plainText = this.service.messageText(
          delivery.text,
          delivery.workspaceId,
          delivery.botId,
        );
        const formatted = telegramFormatting(plainText);
        const payload = delivery.editMessageId
          ? {
              chat_id: delivery.chatId,
              message_id: delivery.editMessageId,
              reply_markup: delivery.markup,
            }
          : {
              chat_id: delivery.chatId,
              ...formatted,
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
            };
        let result: { message_id: number } | true;
        try {
          result = file
            ? await this.sendMedia(delivery, file, signal)
            : await this.client.call(
                delivery.editMessageId ? 'editMessageReplyMarkup' : 'sendMessage',
                payload,
                signal,
              );
        } catch (error) {
          // A confirmed rejection is safe to retry as plain text; uncertain sends are never replayed.
          if (
            file ||
            delivery.editMessageId ||
            !formatted.entities ||
            !(error instanceof TelegramApiError) ||
            error.code !== 400 ||
            error.uncertain
          )
            throw error;
          result = await this.client.call(
            'sendMessage',
            { ...payload, text: plainText, entities: undefined },
            signal,
          );
        }
        const messageId =
          delivery.editMessageId ?? (typeof result === 'object' ? result?.message_id : undefined);
        if (!Number.isSafeInteger(messageId)) {
          jobs.deliveryState(delivery.id, 'uncertain');
          this.service.reportDeliveryError(
            'Telegram did not confirm reply delivery. Check Telegram before sending another request.',
          );
          return;
        }
        jobs.delivered(delivery.id, messageId!);
      } catch (error) {
        const failure =
          error instanceof TelegramApiError ? error : new TelegramApiError(0, 0, true);
        if (delivery.editMessageId && failure.code === 400) {
          jobs.delivered(delivery.id, delivery.editMessageId);
          return;
        } else if (
          delivery.editMessageId &&
          delivery.attempts < 3 &&
          (failure.uncertain || failure.code >= 500 || failure.code === 0)
        ) {
          this.nextAt = Date.now() + 2000;
          jobs.deliveryState(delivery.id, 'pending', this.nextAt);
        } else if (failure.uncertain) jobs.deliveryState(delivery.id, 'uncertain');
        else if (failure.code === 429 && delivery.attempts < 10) {
          this.nextAt = Date.now() + Math.max(1000, failure.retryAfter * 1000);
          jobs.deliveryState(delivery.id, 'pending', this.nextAt);
        } else {
          const notify = delivery.media && !this.stopped && this.service.deliveryAllowed(delivery);
          jobs.deliveryState(delivery.id, 'failed');
          if (notify) this.mediaNotice(delivery);
        }
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
      this.lastWasDraft = true;
      try {
        await this.client.call(
          this.draftsSupported ? 'sendMessageDraft' : 'sendChatAction',
          this.draftsSupported
            ? {
                chat_id: draft.job.chatId,
                draft_id: draft.draftId,
                ...telegramFormatting(
                  this.service.messageText(draft.text, draft.job.workspaceId, draft.job.botId),
                  false,
                ),
              }
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
  private mediaNotice(delivery: TelegramDelivery) {
    this.service.jobs.queue(
      {
        connectionId: delivery.connectionId,
        chatId: delivery.chatId,
        workspaceId: delivery.workspaceId,
        botId: delivery.botId,
        workspaceEvent: delivery.workspaceEvent,
        replyTo: delivery.replyTo,
        text: `Could not deliver “${telegramMediaLabel(delivery.media!.label, 180)}”. The file may be unavailable, too large, or unsupported by Telegram. Open Mukai or use the original public link to access it.`,
      },
      `${delivery.id}:notice`,
    );
  }
  private async sendMedia(
    delivery: TelegramDelivery,
    file: TelegramMediaFile,
    signal: AbortSignal,
  ) {
    const method = telegramMediaMethod(file);
    const send = (target: typeof method) => {
      const form = new FormData();
      form.set('chat_id', String(delivery.chatId));
      form.set(
        'caption',
        this.service.messageText(
          telegramMediaLabel(delivery.media!.label),
          delivery.workspaceId,
          delivery.botId,
        ),
      );
      if (delivery.replyTo)
        form.set(
          'reply_parameters',
          JSON.stringify({ message_id: delivery.replyTo, allow_sending_without_reply: true }),
        );
      const name = telegramMediaLabel(file.name.split(/[\\/]/).at(-1) || 'file', 180);
      form.set(
        telegramMediaField[target],
        new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
        name,
      );
      return this.client.call<{ message_id: number }>(target, form, signal);
    };
    try {
      return await send(method);
    } catch (error) {
      // A confirmed native-player rejection can fall back to the original downloadable file.
      if (
        method === 'sendDocument' ||
        !(error instanceof TelegramApiError) ||
        error.code !== 400 ||
        error.uncertain
      )
        throw error;
      if (this.stopped || !this.service.deliveryAllowed(delivery)) throw error;
      return send('sendDocument');
    }
  }
}
