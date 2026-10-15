import type { ToolApproval } from '../../shared/approvals';
import type { TelegramConnection } from '../repositories/telegramConnectionRepository';
import {
  TelegramEventRepository,
  type TelegramEvent,
} from '../repositories/telegramEventRepository';
import type { ApprovalService } from '../services/approvalService';
import type { NotificationService } from '../services/notificationService';
import type { TelegramService } from '../services/telegramService';
import { ApiError } from '../config';
import { approvalDetails } from './presentation';
import { parseCommand } from './commands';
import type { TelegramDelivery, TelegramMarkup, TelegramUpdate } from './types';

type Button = { text: string; callback_data: string };
const line = (text: string) => text.replace(/[\r\n]/g, ' ');

/** Durable workspace activity and user actions, independent of the currently selected chat. */
export class TelegramActivity {
  private nextSync = 0;
  readonly repository: TelegramEventRepository;
  constructor(
    private service: TelegramService,
    private approvals: ApprovalService,
    private notifications: NotificationService,
  ) {
    this.repository = new TelegramEventRepository(service.jobs.database);
    service.attachActivity(this);
  }
  private approval(event: TelegramEvent) {
    return this.approvals
      .state()
      .pending.find(
        (request) =>
          request.id === event.sourceId &&
          request.botId === event.botId &&
          this.service.approvalWorkspace(request) === event.workspaceId,
      );
  }
  private allowed(
    event: TelegramEvent,
    connection = this.service.connection(),
    ignoreExpiry = false,
  ) {
    return (
      !!connection &&
      event.connectionId === connection.id &&
      event.authorizationId === connection.authorizationId &&
      (ignoreExpiry || event.expiresAt > Date.now()) &&
      this.service.workspaceAllowed(
        connection.id,
        connection.ownerChatId ?? 0,
        event.workspaceId,
        event.botId,
      )
    );
  }
  private current(event: TelegramEvent) {
    if (!this.allowed(event) || event.state !== 'open') return false;
    if (event.kind === 'approval') return !!this.approval(event);
    const notification = this.repository.notification(event.sourceId);
    return (
      !!notification &&
      notification.workspace_id === event.workspaceId &&
      notification.bot_id === event.botId &&
      !notification.dismissed_at
    );
  }
  validDelivery(value: TelegramDelivery) {
    if (!value.eventId) return true;
    const event = this.repository.find(value.eventId);
    if (!event) return false;
    if (value.editMessageId) {
      // Recompute at send time: an older read/edit retry must never restore consumed buttons.
      value.markup = this.keyboard(event);
      return this.allowed(event, undefined, true);
    }
    return (
      this.current(event) &&
      (event.kind !== 'notification' || !this.repository.notification(event.sourceId)?.read_at)
    );
  }
  private button(event: TelegramEvent, text: string, action: string): Button {
    return { text, callback_data: `t:${event.id}:${action}` };
  }
  private keyboard(event: TelegramEvent): TelegramMarkup {
    if (!this.current(event)) return { inline_keyboard: [] };
    if (event.kind !== 'notification') return { inline_keyboard: [] };
    if (event.continued) return { inline_keyboard: [[this.button(event, 'Dismiss', 'dismiss')]] };
    if (this.repository.notification(event.sourceId)?.read_at)
      return {
        inline_keyboard: [
          [this.button(event, 'Reply', 'continue'), this.button(event, 'Dismiss', 'dismiss')],
        ],
      };
    return {
      inline_keyboard: [
        [this.button(event, 'Reply', 'continue')],
        [this.button(event, 'Mark read', 'read'), this.button(event, 'Dismiss', 'dismiss')],
      ],
    };
  }
  private postApproval(connection: TelegramConnection, request: ToolApproval, key?: string) {
    if (!this.repository.canQueue()) return;
    const workspaceId = this.service.approvalWorkspace(request);
    if (
      !workspaceId ||
      !this.service.workspaceAllowed(
        connection.id,
        connection.ownerChatId!,
        workspaceId,
        request.botId,
      )
    )
      return;
    const existing = this.repository.existing(connection, 'approval', request.id);
    const previous = existing && this.repository.find(String(existing.id));
    const reusable = previous && previous.state === 'open' && previous.expiresAt > Date.now();
    if (reusable && !key) return;
    if (previous && !reusable) this.repository.remove(previous.id);
    const event = reusable
      ? this.repository.refresh(previous.id)
      : this.repository.create(connection, 'approval', request.id, workspaceId, request.botId);
    const details = approvalDetails(request.input);
    const reviewable = details.length <= 12000;
    const question = request.ask;
    let text = `${question?.action === 'clarification' ? 'Question' : 'Approval required'}\n`;
    if (request.target) text += `From: ${line(request.target.name)}\n`;
    text += question
      ? `\n${question.question}`
      : `Tool: ${line(request.toolName)}\n\n${reviewable ? '```json\n' + details + '\n```' : 'This request is too large to review safely in Telegram. Open Mukai to review and approve it.'}`;
    const rows: Button[][] = [];
    if (question?.action === 'clarification') {
      question.options?.forEach((option, index) => {
        text += `\n\n${index + 1}. ${option.label}${option.recommended ? ' (recommended)' : ''}${option.description ? '\n' + option.description : ''}`;
        rows.push([this.button(event, `${index + 1}. ${option.label}`.slice(0, 64), 'o' + index)]);
      });
      text += '\n\nChoose an answer below, or reply directly to this message with your own answer.';
      rows.push([this.button(event, 'Type an answer', 'answer')]);
    } else {
      rows.push([
        ...(reviewable ? [this.button(event, 'Approve', 'yes')] : []),
        this.button(event, 'Deny', 'no'),
      ]);
      if (question?.action === 'approval')
        rows.push([this.button(event, 'Deny with reason', 'reason')]);
    }
    this.send(event, text, { inline_keyboard: rows }, key ?? `event:${event.id}`);
  }
  private postNotification(connection: TelegramConnection, id: string, key?: string) {
    if (!this.repository.canQueue()) return;
    const notification = this.repository.notification(id);
    if (!notification || notification.dismissed_at || notification.read_at) return;
    const workspaceId = String(notification.workspace_id),
      botId = String(notification.bot_id);
    if (!this.service.workspaceAllowed(connection.id, connection.ownerChatId!, workspaceId, botId))
      return;
    const existing = this.repository.existing(connection, 'notification', id);
    const previous = existing && this.repository.find(String(existing.id));
    const reusable = previous && previous.state === 'open' && previous.expiresAt > Date.now();
    if (reusable && !key) return;
    if (previous && !reusable) this.repository.remove(previous.id);
    const event = reusable
      ? this.repository.refresh(previous.id)
      : this.repository.create(connection, 'notification', id, workspaceId, botId);
    const text = `Update: ${line(String(notification.title))}\n\n${notification.message}`;
    this.send(
      event,
      text,
      {
        inline_keyboard: [
          [this.button(event, 'Reply', 'continue')],
          [this.button(event, 'Mark read', 'read'), this.button(event, 'Dismiss', 'dismiss')],
        ],
      },
      key ?? `event:${event.id}`,
    );
  }
  private send(
    event: TelegramEvent,
    text: string,
    markup: TelegramMarkup | undefined,
    id: string,
    replyTo?: number,
    replyAction?: 'deny_reason',
  ) {
    const connection = this.service.connection();
    if (!connection?.ownerChatId || !this.allowed(event, connection)) return;
    this.service.jobs.queue(
      {
        connectionId: connection.id,
        chatId: connection.ownerChatId,
        workspaceId: event.workspaceId,
        botId: event.botId,
        workspaceEvent: true,
        eventId: event.id,
        text,
        markup,
        replyTo,
        replyAction,
      },
      id,
    );
  }
  private result(event: TelegramEvent, text: string, id: string, replyTo?: number) {
    const connection = this.service.connection();
    if (!connection?.ownerChatId || !this.allowed(event, connection)) return;
    this.service.jobs.queue(
      {
        connectionId: connection.id,
        chatId: connection.ownerChatId,
        workspaceId: event.workspaceId,
        botId: event.botId,
        workspaceEvent: true,
        text,
        replyTo,
      },
      id,
    );
  }
  /** Runs inside the inbox transaction: save intentions; settle approvals only after commit. */
  handle(connection: TelegramConnection, update: TelegramUpdate, id: string) {
    const callback = update.callback_query;
    const message = update.message ?? callback?.message;
    if (!message) return false;
    if (callback?.data?.startsWith('t:')) {
      const match =
        /^t:([A-Za-z0-9_-]{24}):(yes|no|reason|answer|o\d{1,2}|read|dismiss|continue)$/.exec(
          callback.data,
        );
      const event = match && this.repository.find(match[1]);
      if (!event || !this.current(event)) {
        this.service.jobs.queue(
          {
            connectionId: connection.id,
            chatId: message.chat.id,
            text: 'This action is no longer available. Use /approvals or /updates for current requests.',
          },
          id,
        );
      } else this.repository.enqueue(id, event.id, match[2], undefined, message.message_id);
      return true;
    }
    const text = update.message?.text?.trim();
    const replyId = update.message?.reply_to_message?.message_id;
    if (replyId && text) {
      const target = this.repository.replyEvent(connection.id, message.chat.id, replyId);
      if (target) {
        const { event } = target;
        if (!this.current(event))
          this.result(event, 'This request was already handled or is no longer available.', id);
        else
          this.repository.enqueue(
            id,
            event.id,
            target.action ?? (event.kind === 'approval' ? 'reply' : 'continue'),
            text,
            message.message_id,
          );
        return true;
      }
    }
    const command = text && parseCommand(text, connection.bot.username);
    if (command !== 'approvals' && command !== 'updates') return false;
    let count = 0;
    if (command === 'approvals') {
      for (const request of this.approvals.state().pending) {
        const workspaceId = this.service.approvalWorkspace(request);
        if (
          !workspaceId ||
          !this.service.workspaceAllowed(connection.id, message.chat.id, workspaceId, request.botId)
        )
          continue;
        this.postApproval(connection, request, `${id}:${request.id}`);
        if (++count >= 30) break;
      }
    } else {
      for (const row of this.repository.notifications(connection, false)) {
        this.postNotification(connection, String(row.id), `${id}:${row.id}`);
        count++;
      }
    }
    if (!count)
      this.service.jobs.queue(
        {
          connectionId: connection.id,
          chatId: message.chat.id,
          text:
            command === 'approvals'
              ? 'No approvals are waiting in your enabled workspaces.'
              : 'No unread updates in your enabled workspaces.',
        },
        id,
      );
    return true;
  }
  tick() {
    const connection = this.service.connection();
    if (!connection?.enabled || !connection.ownerChatId || !connection.owner) return;
    for (const action of this.repository.actions()) {
      const event = this.repository.find(action.eventId);
      try {
        if (!event || !this.current(event)) {
          if (event)
            this.result(
              event,
              'This request was already handled or is no longer available.',
              `${action.id}:result`,
            );
          this.repository.done(action.id);
          continue;
        }
        if (event.kind === 'approval') {
          const request = this.approval(event)!;
          if (request.ask?.action === 'clarification') {
            if (action.action === 'answer') {
              this.send(
                event,
                `${request.ask.question}\n\nReply to this message with your answer.`,
                { force_reply: true, input_field_placeholder: 'Your answer' },
                `${action.id}:prompt`,
              );
              this.repository.done(action.id);
              continue;
            }
            const option = /^o(\d{1,2})$/.exec(action.action);
            const answer =
              action.action === 'reply'
                ? action.value
                : option
                  ? request.ask.options?.[Number(option[1])]?.label
                  : undefined;
            if (!answer)
              throw new ApiError(400, 'Choose an answer or reply to the question with text.');
            this.approvals.answer(request.id, answer, event.workspaceId);
            this.result(
              event,
              'Your answer was sent to the bot.',
              `${action.id}:result`,
              action.sourceMessageId,
            );
          } else {
            if (action.action === 'reason') {
              if (request.ask?.action !== 'approval')
                throw new ApiError(400, 'This request does not accept a denial reason.');
              this.send(
                event,
                'Reply to this message with your reason for denying this request. It will be denied when you send your reason. You can still use Approve or Deny on the original request.',
                { force_reply: true, input_field_placeholder: 'Reason for denying' },
                `${action.id}:prompt`,
                undefined,
                'deny_reason',
              );
              this.repository.done(action.id);
              continue;
            }
            if (!['yes', 'no', 'deny_reason'].includes(action.action))
              throw new ApiError(400, 'Use the Approve or Deny buttons for this request.');
            if (action.action === 'yes' && approvalDetails(request.input).length > 12000)
              throw new ApiError(400, 'Review and approve this large request in Mukai.');
            if (action.action === 'deny_reason' && !action.value?.trim())
              throw new ApiError(400, 'Reply with a reason for denying this request.');
            this.approvals.decide(
              request.id,
              action.action === 'yes',
              event.workspaceId,
              action.action === 'deny_reason' ? (action.value ?? undefined) : undefined,
            );
            this.result(
              event,
              action.action === 'yes'
                ? 'Approved. The bot can continue.'
                : action.action === 'deny_reason'
                  ? 'Denied. Your reason was sent to the bot.'
                  : 'Denied. The action was not authorized.',
              `${action.id}:result`,
              action.sourceMessageId,
            );
          }
        } else if (['read', 'dismiss'].includes(action.action)) {
          this.notifications.mark(
            event.workspaceId,
            event.sourceId,
            action.action as 'read' | 'dismiss',
          );
          this.result(
            event,
            action.action === 'read' ? 'Update marked as read.' : 'Update dismissed.',
            `${action.id}:result`,
          );
        } else if (action.action === 'continue') {
          if (event.continued && !action.value)
            throw new ApiError(
              409,
              'This update’s reply is already open. Send your message to continue with the bot.',
            );
          if (action.value && this.service.jobs.jobs('queued').length >= 20)
            throw new ApiError(409, 'Your message queue is full. Please try again shortly.');
          const conversation = this.notifications.continue(event.workspaceId, event.sourceId);
          const session = this.service.sessions.selectNotification(
            connection.id,
            connection.ownerChatId,
            event.workspaceId,
            event.botId,
            event.sourceId,
            conversation.id,
          );
          this.notifications.mark(event.workspaceId, event.sourceId, 'read');
          if (action.value) {
            this.service.jobs.enqueue(session, action.value, action.sourceMessageId!, action.id);
          } else
            this.result(
              event,
              'This update’s conversation is ready. Send your message to continue with the bot.',
              `${action.id}:result`,
            );
          this.repository.markContinued(event.id);
        } else throw new ApiError(400, 'This action is not available for this update.');
        if (event.kind === 'approval' || action.action === 'dismiss')
          this.repository.resolve(event.id);
      } catch (error) {
        if (event)
          this.result(
            event,
            error instanceof ApiError
              ? error.message
              : 'This action could not be completed. Open Mukai to review the current request.',
            `${action.id}:result`,
          );
      }
      this.repository.done(action.id);
    }
    if (Date.now() < this.nextSync) return;
    this.nextSync = Date.now() + 1000;
    for (const request of this.approvals.state().pending) {
      this.repository.database.transaction(() => this.postApproval(connection, request));
    }
    for (const row of this.repository.notifications(connection)) {
      this.repository.database.transaction(() => this.postNotification(connection, String(row.id)));
    }
    for (const event of this.repository.events(connection)) {
      if (event.state === 'open' && !this.current(event)) this.repository.resolve(event.id);
      const current = this.current(event);
      const read =
        current &&
        event.kind === 'notification' &&
        this.repository.notification(event.sourceId)?.read_at;
      if (current && !read && !event.continued) continue;
      for (const row of this.repository.sentMessages(event.id)) {
        this.service.jobs.queue(
          {
            connectionId: connection.id,
            chatId: connection.ownerChatId,
            workspaceId: event.workspaceId,
            botId: event.botId,
            workspaceEvent: true,
            eventId: event.id,
            text: ' ',
            markup: this.keyboard(event),
            editMessageId: Number(row.telegram_message_id),
          },
          `${!current ? 'clear' : event.continued ? 'continued' : 'read'}:${row.id}`,
        );
      }
      if (!current) this.repository.markButtonsCleared(event.id);
    }
    this.repository.prune();
  }
}
