import type { TelegramService } from '../services/telegramService';
import { TelegramPoller } from './poller';
import { TelegramDeliveryQueue } from './delivery';
import { TelegramChatOutput } from './chatOutput';
import type { TelegramJob } from './types';
import { telegramCommands } from './commands';

/** One installation-owned poller; AI turns are independent from incoming commands. */
export class TelegramRuntime {
  private poller?: TelegramPoller;
  private delivery?: TelegramDeliveryQueue;
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, { job: TelegramJob; promise: Promise<void> }>();
  private stopping?: Promise<void>;
  private control?: AbortController;
  private registration?: Promise<unknown>;
  constructor(private service: TelegramService) {
    service.attachRuntime(this);
  }
  start() {
    const connection = this.service.connection();
    if (!connection?.enabled || this.poller) return;
    try {
      this.control = new AbortController();
      const client = this.service.client(connection);
      this.service.jobs.recoverDelivery();
      this.service.jobs.prune();
      this.delivery = new TelegramDeliveryQueue(this.service, client);
      this.poller = new TelegramPoller(
        client,
        () => this.service.jobs.offset(connection.id),
        (updates) => this.service.accept(connection.id, updates),
        (state, error) => this.service.setRuntime(state, error),
      );
      // Commands improve discoverability; failure does not prevent an otherwise valid connection.
      this.registration = client
        .call('setMyCommands', { commands: telegramCommands }, this.control.signal)
        .catch(() => {});
      this.poller.start();
      this.timer = setInterval(() => this.tick(), 250);
      this.timer.unref();
    } catch {
      this.service.setRuntime(
        'error',
        'Could not open the saved Telegram credentials. Reconnect the bot.',
      );
    }
  }
  private tick() {
    try {
      for (const value of this.service.jobs.inbox()) {
        this.service.jobs.consumeInbox(value.sequence, () =>
          this.service.dispatch(value.connectionId, value.update),
        );
        if (value.update.callback_query?.message)
          this.delivery?.acknowledge(
            value.update.callback_query.id,
            value.update.callback_query.message.chat.id,
          );
      }
      for (const job of this.service.jobs.jobs('running')) {
        if (this.active.has(job.conversationId)) continue;
        if (!this.service.jobAllowed(job)) this.service.jobs.state(job.id, 'cancelled');
        else this.service.recover(job);
      }
      for (const job of this.service.jobs.jobs('queued')) {
        if (this.active.size >= 2) break;
        if (!this.service.jobAllowed(job)) {
          this.service.jobs.state(job.id, 'cancelled');
          continue;
        }
        if (
          this.active.has(job.conversationId) ||
          this.service.chats.suspended(job.conversationId) ||
          this.service.jobs
            .jobs('running')
            .some((value) => value.conversationId === job.conversationId)
        )
          continue;
        this.service.jobs.state(job.id, 'running');
        const promise = this.run(job)
          .catch(() => {
            this.service.jobs.state(job.id, 'interrupted');
            this.service.setRuntime(
              'error',
              'A Telegram response could not be saved. Review the conversation in Mukai before retrying.',
            );
          })
          .finally(() => this.active.delete(job.conversationId));
        this.active.set(job.conversationId, { job, promise });
      }
      this.delivery?.tick();
    } catch {
      this.service.setRuntime(
        'error',
        'Telegram could not process a saved update. Reconnect to try again.',
      );
    }
  }
  private async run(job: TelegramJob) {
    const delivery = this.delivery;
    if (!delivery) return;
    const output = new TelegramChatOutput(job, delivery, () => {
      if (this.service.jobAllowed(job))
        this.service.jobs.queue(
          {
            connectionId: job.connectionId,
            chatId: job.chatId,
            workspaceId: job.workspaceId,
            botId: job.botId,
            text: 'This task needs your approval in Mukai. Open the Telegram conversation there to continue.',
          },
          `${job.id}:approval`,
        );
    });
    try {
      await this.service.conversations.sendPrivate(
        job.conversationId,
        {
          requestId: job.id,
          text: job.text,
          attachmentIds: [],
        },
        output,
        'telegram',
      );
      this.service.finish(job, output.message);
    } catch {
      this.service.finish(job);
    } finally {
      delivery.end(job.id);
    }
  }
  stop(cancelQueued = true) {
    return (this.stopping ??= this.stopRuntime(cancelQueued).finally(() => {
      this.stopping = undefined;
    }));
  }
  shutdown() {
    return this.stop(false);
  }
  private async stopRuntime(cancelQueued: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.control?.abort();
    const polling = this.poller?.stop(),
      sending = this.delivery?.stop();
    this.poller = undefined;
    // Settings changes cancel queued work; ordinary shutdown retains unstarted turns.
    // Running operations are stopped and never replayed automatically on restart.
    const jobs = [
      ...this.service.jobs.jobs('running'),
      ...(cancelQueued ? this.service.jobs.jobs('queued') : []),
    ];
    for (const job of jobs) {
      if (cancelQueued) this.service.jobs.cancelConversation(job.conversationId);
      this.service.chats.stopConversation(job.conversationId);
    }
    await Promise.allSettled([
      polling,
      sending,
      this.registration,
      ...[...this.active.values()].map((value) => value.promise),
    ]);
    this.delivery = undefined;
    this.service.setRuntime('stopped');
  }
}
