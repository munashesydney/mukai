import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database';
import type { TelegramSession } from '../telegram/types';

export class TelegramSessionRepository {
  constructor(private database: Database) {}
  private project(row: Row): TelegramSession {
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      chatId: Number(row.chat_id),
      workspaceId: String(row.workspace_id),
      botId: String(row.bot_id),
      conversationId: String(row.conversation_id),
      notificationId: (row.notification_id as string | null) ?? undefined,
    };
  }
  current(connectionId: string, chatId: number) {
    const row = this.database.get(
      'SELECT * FROM telegram_sessions WHERE connection_id=? AND chat_id=? AND selected=1',
      connectionId,
      chatId,
    );
    return row ? this.project(row) : undefined;
  }
  all() {
    return this.database.all('SELECT * FROM telegram_sessions').map((row) => this.project(row));
  }
  select(
    connectionId: string,
    chatId: number,
    workspaceId: string,
    botId: string,
    fresh = false,
    notificationId?: string,
  ) {
    // Savepoints compose with the inbox transaction that consumes this command.
    this.database.db.exec('SAVEPOINT telegram_session');
    try {
      const result = (() => {
        this.database.run(
          'UPDATE telegram_sessions SET selected=0 WHERE connection_id=? AND chat_id=?',
          connectionId,
          chatId,
        );
        const existing = this.database.get(
          'SELECT * FROM telegram_sessions WHERE connection_id=? AND chat_id=? AND workspace_id=?',
          connectionId,
          chatId,
          workspaceId,
        );
        if (existing && !fresh && existing.bot_id === botId && !existing.notification_id) {
          this.database.run(
            'UPDATE telegram_sessions SET selected=1 WHERE id=?',
            String(existing.id),
          );
          return this.project(existing);
        }
        // An explicit UUID guarantees we never adopt an empty desktop conversation.
        const conversationId = randomUUID(),
          now = new Date().toISOString();
        this.database.run(
          `INSERT INTO conversations(id,workspace_id,kind,name,owner_bot_id,created_at,updated_at)
        VALUES(?,?,'private','Telegram conversation',?,?,?)`,
          conversationId,
          workspaceId,
          botId,
          now,
          now,
        );
        this.database.run('INSERT INTO conversation_bots VALUES(?,?)', conversationId, botId);
        if (existing) {
          this.database.run(
            'UPDATE telegram_sessions SET bot_id=?,conversation_id=?,selected=1,notification_id=? WHERE id=?',
            botId,
            conversationId,
            notificationId ?? null,
            String(existing.id),
          );
          return { ...this.project(existing), botId, conversationId, notificationId };
        }
        const session = {
          id: randomUUID(),
          connectionId,
          chatId,
          workspaceId,
          botId,
          conversationId,
          notificationId,
        };
        this.database.run(
          'INSERT INTO telegram_sessions(id,connection_id,chat_id,workspace_id,bot_id,conversation_id,notification_id,selected) VALUES(?,?,?,?,?,?,?,1)',
          session.id,
          connectionId,
          chatId,
          workspaceId,
          botId,
          conversationId,
          notificationId ?? null,
        );
        return session;
      })();
      this.database.db.exec('RELEASE telegram_session');
      return result;
    } catch (error) {
      this.database.db.exec('ROLLBACK TO telegram_session; RELEASE telegram_session');
      throw error;
    }
  }
  forgetWorkspace(id: string) {
    this.database.run('DELETE FROM telegram_sessions WHERE workspace_id=?', id);
  }
  selectNotification(
    connectionId: string,
    chatId: number,
    workspaceId: string,
    botId: string,
    notificationId: string,
    conversationId: string,
  ) {
    this.database.transaction(() => {
      this.database.run(
        'UPDATE telegram_sessions SET selected=0 WHERE connection_id=? AND chat_id=?',
        connectionId,
        chatId,
      );
      this.database.run(
        `INSERT INTO telegram_sessions(id,connection_id,chat_id,workspace_id,bot_id,conversation_id,notification_id,selected)
        VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(connection_id,chat_id,workspace_id) DO UPDATE SET
        bot_id=excluded.bot_id,conversation_id=excluded.conversation_id,notification_id=excluded.notification_id,selected=1`,
        randomUUID(),
        connectionId,
        chatId,
        workspaceId,
        botId,
        conversationId,
        notificationId,
      );
    });
    return this.current(connectionId, chatId)!;
  }
}
