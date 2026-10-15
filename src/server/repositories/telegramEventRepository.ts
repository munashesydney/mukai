import { randomBytes } from 'node:crypto';
import type { Database, Row } from '../db/database';
import type { TelegramConnection } from './telegramConnectionRepository';

export interface TelegramEvent {
  id: string;
  connectionId: string;
  authorizationId: string;
  workspaceId: string;
  botId: string;
  kind: 'approval' | 'notification';
  sourceId: string;
  state: 'open' | 'resolved';
  expiresAt: number;
  continued: boolean;
}

export class TelegramEventRepository {
  constructor(readonly database: Database) {}
  private project(row: Row): TelegramEvent {
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      authorizationId: String(row.authorization_id),
      workspaceId: String(row.workspace_id),
      botId: String(row.bot_id),
      kind: row.kind as TelegramEvent['kind'],
      sourceId: String(row.source_id),
      state: row.state as TelegramEvent['state'],
      expiresAt: Number(row.expires_at),
      continued: !!row.continued,
    };
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM telegram_events WHERE id=?', id);
    return row ? this.project(row) : undefined;
  }
  remove(id: string) {
    this.database.run('DELETE FROM telegram_events WHERE id=?', id);
  }
  existing(connection: TelegramConnection, kind: TelegramEvent['kind'], sourceId: string) {
    return this.database.get(
      'SELECT id FROM telegram_events WHERE connection_id=? AND authorization_id=? AND kind=? AND source_id=?',
      connection.id,
      connection.authorizationId,
      kind,
      sourceId,
    );
  }
  create(
    connection: TelegramConnection,
    kind: TelegramEvent['kind'],
    sourceId: string,
    workspaceId: string,
    botId: string,
  ) {
    const id = randomBytes(18).toString('base64url');
    this.database.run(
      `INSERT INTO telegram_events(id,connection_id,authorization_id,workspace_id,bot_id,kind,source_id,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      id,
      connection.id,
      connection.authorizationId,
      workspaceId,
      botId,
      kind,
      sourceId,
      Date.now(),
      Date.now() + 7 * 86400000,
    );
    return this.find(id)!;
  }
  events(connection: TelegramConnection) {
    return this.database
      .all(
        "SELECT * FROM telegram_events WHERE connection_id=? AND authorization_id=? AND (state='open' OR buttons_cleared=0)",
        connection.id,
        connection.authorizationId,
      )
      .map((row) => this.project(row));
  }
  resolve(id: string) {
    this.database.run("UPDATE telegram_events SET state='resolved' WHERE id=?", id);
  }
  markContinued(id: string) {
    this.database.run('UPDATE telegram_events SET continued=1 WHERE id=?', id);
  }
  refresh(id: string) {
    this.database.run(
      "UPDATE telegram_events SET expires_at=?,buttons_cleared=0 WHERE id=? AND state='open'",
      Date.now() + 7 * 86400000,
      id,
    );
    return this.find(id)!;
  }
  markButtonsCleared(id: string) {
    if (
      !this.database.get(
        "SELECT 1 FROM telegram_outbox WHERE event_id=? AND edit_message_id IS NULL AND state IN ('pending','sending')",
        id,
      )
    )
      this.database.run('UPDATE telegram_events SET buttons_cleared=1 WHERE id=?', id);
  }
  canQueue() {
    return (
      Number(
        this.database.get(
          "SELECT COUNT(*) AS n FROM telegram_outbox WHERE state IN ('pending','sending')",
        )?.n,
      ) < 200
    );
  }
  enqueue(id: string, eventId: string, action: string, value?: string, sourceMessageId?: number) {
    this.database.run(
      'INSERT OR IGNORE INTO telegram_actions(id,event_id,action,value,source_message_id,created_at) VALUES(?,?,?,?,?,?)',
      id,
      eventId,
      action,
      value ?? null,
      sourceMessageId ?? null,
      Date.now(),
    );
  }
  actions() {
    return this.database
      .all(
        "SELECT * FROM telegram_actions WHERE state='pending' ORDER BY created_at,rowid LIMIT 50",
      )
      .map((row) => ({
        id: String(row.id),
        eventId: String(row.event_id),
        action: String(row.action),
        value: row.value as string | null,
        sourceMessageId: row.source_message_id === null ? undefined : Number(row.source_message_id),
      }));
  }
  done(id: string) {
    this.database.run("UPDATE telegram_actions SET state='done' WHERE id=?", id);
  }
  replyEvent(connectionId: string, chatId: number, telegramMessageId: number) {
    const row = this.database.get(
      `SELECT event_id,reply_action FROM telegram_outbox WHERE connection_id=? AND chat_id=? AND telegram_message_id=? AND event_id IS NOT NULL AND state='sent'`,
      connectionId,
      chatId,
      telegramMessageId,
    );
    const event = row && this.find(String(row.event_id));
    return event
      ? { event, action: row.reply_action === 'deny_reason' ? ('deny_reason' as const) : undefined }
      : undefined;
  }
  notification(id: string) {
    return this.database.get('SELECT * FROM bot_notifications WHERE id=?', id);
  }
  notifications(connection: TelegramConnection, onlyNew = true) {
    return this.database.all(
      `SELECT n.* FROM bot_notifications n JOIN telegram_access a ON a.workspace_id=n.workspace_id
      WHERE n.dismissed_at IS NULL AND n.read_at IS NULL AND (?=0 OR NOT EXISTS(
        SELECT 1 FROM telegram_events e WHERE e.connection_id=? AND e.authorization_id=? AND e.kind='notification' AND e.source_id=n.id))
      ORDER BY n.created_at,n.rowid LIMIT 30`,
      Number(onlyNew),
      connection.id,
      connection.authorizationId,
    );
  }
  sentMessages(eventId: string) {
    return this.database.all(
      "SELECT id,telegram_message_id FROM telegram_outbox WHERE event_id=? AND state='sent' AND markup_json IS NOT NULL AND edit_message_id IS NULL",
      eventId,
    );
  }
  prune() {
    this.database.run('DELETE FROM telegram_events WHERE expires_at<?', Date.now() - 7 * 86400000);
  }
}
