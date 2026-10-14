import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database';
import type {
  TelegramDelivery,
  TelegramJob,
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
  }
  runnable(id: string) {
    return (
      this.database.get(
        "SELECT 1 FROM telegram_chat_jobs WHERE id=? AND state IN ('running','queued')",
        id,
      ) !== undefined
    );
  }
  queue(value: Omit<TelegramDelivery, 'id' | 'attempts'>, id: string = randomUUID()) {
    this.database.run(
      `INSERT OR IGNORE INTO telegram_outbox(id,connection_id,chat_id,text,markup_json,reply_to,workspace_id,bot_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      id,
      value.connectionId,
      value.chatId,
      value.text,
      value.markup ? JSON.stringify(value.markup) : null,
      value.replyTo ?? null,
      value.workspaceId ?? null,
      value.botId ?? null,
      Date.now(),
    );
  }
  complete(job: TelegramJob, parts: string[], state: 'done' | 'interrupted') {
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
          },
          `${job.id}:${index}`,
        );
      this.state(job.id, state);
    });
  }
  delivery(now: number): TelegramDelivery | undefined {
    const row = this.database.get(
      "SELECT * FROM telegram_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY sequence LIMIT 1",
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
