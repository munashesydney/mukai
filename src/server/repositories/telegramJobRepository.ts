import { randomUUID } from 'node:crypto';
import { splitTelegramText } from '../telegram/commands';
import { telegramBodyLimit } from '../telegram/presentation';
import type { Database, Row } from '../db/database';
import type {
  TelegramDelivery,
  TelegramJob,
  TelegramMediaReference,
  TelegramSession,
  TelegramUpdate,
} from '../telegram/types';

export class TelegramJobRepository {
  constructor(readonly database: Database) {}
  offset(connectionId: string) {
    return Number(
      this.database.get('SELECT next_offset FROM telegram_connections WHERE id=?', connectionId)
        ?.next_offset || 0,
    );
  }
  accept(connectionId: string, updates: { id: number; payload?: TelegramUpdate }[]) {
    this.database.transaction(() => {
      let offset = this.offset(connectionId);
      for (const update of updates) {
        if (update.id < offset) continue;
        if (update.payload) {
          if (Number(this.database.get('SELECT COUNT(*) AS n FROM telegram_inbox')?.n) >= 200)
            throw new Error('Telegram inbox is full.');
          this.database.run(
            'INSERT OR IGNORE INTO telegram_inbox(connection_id,update_id,payload) VALUES(?,?,?)',
            connectionId,
            update.id,
            JSON.stringify(update.payload),
          );
        }
        offset = Math.max(offset, update.id + 1);
      }
      this.database.run(
        'UPDATE telegram_connections SET next_offset=? WHERE id=?',
        offset,
        connectionId,
      );
    });
  }
  inbox() {
    return this.database
      .all('SELECT * FROM telegram_inbox ORDER BY sequence LIMIT 50')
      .map((row) => ({
        sequence: Number(row.sequence),
        connectionId: String(row.connection_id),
        update: JSON.parse(String(row.payload)) as TelegramUpdate,
      }));
  }
  removeInbox(sequence: number) {
    this.database.run('DELETE FROM telegram_inbox WHERE sequence=?', sequence);
  }
  consumeInbox(sequence: number, dispatch: () => void) {
    this.database.transaction(() => {
      dispatch();
      this.removeInbox(sequence);
    });
  }
  clearInbox() {
    this.database.run('DELETE FROM telegram_inbox');
  }
  enqueue(session: TelegramSession, text: string, sourceMessageId: number, id: string) {
    this.database.run(
      `INSERT OR IGNORE INTO telegram_chat_jobs(id,connection_id,session_id,conversation_id,workspace_id,bot_id,chat_id,source_message_id,text,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'queued',?)`,
      id,
      session.connectionId,
      session.id,
      session.conversationId,
      session.workspaceId,
      session.botId,
      session.chatId,
      sourceMessageId,
      text,
      Date.now(),
    );
    if (session.notificationId)
      this.database.run(
        'UPDATE telegram_chat_jobs SET notification_id=? WHERE id=?',
        session.notificationId,
        id,
      );
  }
  private project(row: Row): TelegramJob {
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      sessionId: String(row.session_id),
      connectionId: String(row.connection_id),
      conversationId: String(row.conversation_id),
      workspaceId: String(row.workspace_id),
      botId: String(row.bot_id),
      chatId: Number(row.chat_id),
      sourceMessageId: Number(row.source_message_id),
      text: String(row.text),
      state: row.state as TelegramJob['state'],
      notificationId: (row.notification_id as string | null) ?? undefined,
    };
  }
  jobs(state: TelegramJob['state']) {
    return this.database
      .all('SELECT * FROM telegram_chat_jobs WHERE state=? ORDER BY sequence', state)
      .map((row) => this.project(row));
  }
  state(id: string, state: TelegramJob['state']) {
    this.database.run('UPDATE telegram_chat_jobs SET state=? WHERE id=?', state, id);
  }
  cancelConversation(id: string) {
    this.database.run(
      "UPDATE telegram_chat_jobs SET state='cancelled' WHERE conversation_id=? AND state IN ('queued','running')",
      id,
    );
    this.database.run(
      `UPDATE telegram_outbox SET state='cancelled' WHERE state='pending' AND EXISTS(
        SELECT 1 FROM telegram_chat_jobs j WHERE j.conversation_id=? AND instr(telegram_outbox.id,j.id||':')=1)`,
      id,
    );
  }
  runnable(id: string) {
    return (
      this.database.get(
        "SELECT 1 FROM telegram_chat_jobs WHERE id=? AND state IN ('running','queued')",
        id,
      ) !== undefined
    );
  }
  deliveryActive(id: string) {
    return !!this.database.get(
      "SELECT 1 FROM telegram_outbox WHERE id=? AND state IN ('pending','sending')",
      id,
    );
  }
  queue(value: Omit<TelegramDelivery, 'id' | 'attempts'>, id: string = randomUUID()) {
    const parts = value.media
      ? [value.text]
      : splitTelegramText(value.text || ' ', telegramBodyLimit);
    this.database.db.exec('SAVEPOINT telegram_delivery');
    try {
      for (const [index, text] of parts.entries()) {
        this.database.run(
          `INSERT OR IGNORE INTO telegram_outbox(id,connection_id,chat_id,text,markup_json,reply_to,workspace_id,bot_id,created_at,workspace_event,event_id,edit_message_id,reply_action,media_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          index ? `${id}:part:${index}` : id,
          value.connectionId,
          value.chatId,
          text,
          value.markup && index === parts.length - 1 ? JSON.stringify(value.markup) : null,
          value.replyTo ?? null,
          value.workspaceId ?? null,
          value.botId ?? null,
          Date.now(),
          Number(value.workspaceEvent ?? false),
          value.eventId ?? null,
          value.editMessageId ?? null,
          value.replyAction ?? null,
          value.media ? JSON.stringify(value.media) : null,
        );
      }
      this.database.db.exec('RELEASE telegram_delivery');
    } catch (error) {
      this.database.db.exec('ROLLBACK TO telegram_delivery; RELEASE telegram_delivery');
      throw error;
    }
  }
  complete(
    job: TelegramJob,
    parts: string[],
    state: 'done' | 'interrupted',
    media: TelegramMediaReference[] = [],
  ) {
    this.database.transaction(() => {
      for (const [index, text] of parts.entries())
        this.queue(
          {
            connectionId: job.connectionId,
            chatId: job.chatId,
            text,
            replyTo: job.sourceMessageId,
            workspaceId: job.workspaceId,
            botId: job.botId,
            workspaceEvent: !!job.notificationId,
          },
          `${job.id}:${index}`,
        );
      for (const [index, reference] of media.entries())
        this.queue(
          {
            connectionId: job.connectionId,
            chatId: job.chatId,
            text: reference.label,
            media: reference,
            replyTo: job.sourceMessageId,
            workspaceId: job.workspaceId,
            botId: job.botId,
            workspaceEvent: !!job.notificationId,
          },
          `${job.id}:media:${index}`,
        );
      this.state(job.id, state);
    });
  }
  splitPending(value: TelegramDelivery) {
    if (value.media) return false;
    const parts = splitTelegramText(value.text, telegramBodyLimit);
    if (parts.length <= 1) return false;
    this.database.transaction(() => {
      this.database.run(
        'UPDATE telegram_outbox SET text=?,markup_json=NULL WHERE id=?',
        parts[0],
        value.id,
      );
      for (let index = 1; index < parts.length; index++)
        this.queue(
          {
            ...value,
            text: parts[index],
            markup: index === parts.length - 1 ? value.markup : undefined,
          },
          `${value.id}:continued:${index}`,
        );
    });
    return true;
  }
  delivery(now: number): TelegramDelivery | undefined {
    const row = this.database.get(
      `SELECT o.*,CASE WHEN o.edit_message_id IS NOT NULL THEN 0
        WHEN o.event_id IS NULL THEN 0 WHEN e.kind='approval' THEN 1 ELSE 2 END AS priority
       FROM telegram_outbox o LEFT JOIN telegram_events e ON e.id=o.event_id
       WHERE o.state='pending' AND o.next_attempt_at<=? ORDER BY priority,o.sequence LIMIT 1`,
      now,
    );
    if (!row) return;
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      chatId: Number(row.chat_id),
      text: String(row.text),
      markup: row.markup_json ? JSON.parse(String(row.markup_json)) : undefined,
      replyTo: row.reply_to === null ? undefined : Number(row.reply_to),
      workspaceId: row.workspace_id as string | undefined,
      botId: row.bot_id as string | undefined,
      attempts: Number(row.attempts),
      workspaceEvent: !!row.workspace_event,
      eventId: (row.event_id as string | null) ?? undefined,
      replyAction: row.reply_action === 'deny_reason' ? 'deny_reason' : undefined,
      editMessageId: row.edit_message_id === null ? undefined : Number(row.edit_message_id),
      priority: Number(row.priority),
      media: row.media_json ? JSON.parse(String(row.media_json)) : undefined,
    };
  }
  sending(id: string) {
    this.database.run(
      "UPDATE telegram_outbox SET state='sending',attempts=attempts+1 WHERE id=?",
      id,
    );
  }
  delivered(id: string, telegramId: number) {
    this.database.run(
      "UPDATE telegram_outbox SET state='sent',telegram_message_id=? WHERE id=?",
      telegramId,
      id,
    );
  }
  deliveryState(
    id: string,
    state: 'pending' | 'uncertain' | 'failed' | 'cancelled',
    nextAttempt = 0,
  ) {
    this.database.run(
      'UPDATE telegram_outbox SET state=?,next_attempt_at=? WHERE id=?',
      state,
      nextAttempt,
      id,
    );
  }
  recoverDelivery() {
    this.database.run("UPDATE telegram_outbox SET state='uncertain' WHERE state='sending'");
  }
  counts() {
    return {
      pending: Number(
        this.database.get(
          "SELECT COUNT(*) AS n FROM telegram_chat_jobs WHERE state IN ('queued','running')",
        )?.n || 0,
      ),
      uncertain: Number(
        this.database.get("SELECT COUNT(*) AS n FROM telegram_outbox WHERE state='uncertain'")?.n ||
          0,
      ),
    };
  }
  prune() {
    const before = Date.now() - 7 * 86400000;
    this.database.run(
      "DELETE FROM telegram_outbox WHERE state IN ('sent','failed','cancelled') AND created_at<?",
      before,
    );
    this.database.run(
      "DELETE FROM telegram_chat_jobs WHERE state IN ('done','cancelled','interrupted') AND created_at<?",
      before,
    );
  }
}
