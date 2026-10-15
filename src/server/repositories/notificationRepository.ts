import { randomUUID } from 'node:crypto';
import type { Bot } from '../../shared/ai';
import type { BotNotification, NotificationInbox } from '../../shared/notifications';
import { ApiError } from '../config';
import type { Database, Row } from '../db/database';
import { ConversationRepository } from './conversationRepository';

export class NotificationRepository {
  constructor(private database: Database) {}
  private project(row: Row): BotNotification {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      botId: String(row.bot_id),
      botName: String(row.bot_name),
      title: String(row.title),
      message: String(row.message),
      sourceConversationId: String(row.source_conversation_id),
      sourceKind: String(row.source_kind),
      createdAt: String(row.created_at),
      readAt: row.read_at as string | null,
      conversationId: row.conversation_id as string | null,
    };
  }
  private require(workspaceId: string, id: string) {
    const row = this.database.get(
      `SELECT n.*, c.kind AS source_kind FROM bot_notifications n
       JOIN conversations c ON c.id=n.source_conversation_id WHERE n.id=? AND n.workspace_id=?`,
      id,
      workspaceId,
    );
    if (!row) throw new ApiError(404, 'Notification not found in this workspace.');
    return this.project(row);
  }
  notify(
    bot: Bot,
    messageId: string,
    toolCallId: string,
    input: { title: string; message: string },
  ) {
    const source = this.database.get(
      `SELECT m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.id=? AND m.bot_id=? AND c.workspace_id=?`,
      messageId,
      bot.id,
      bot.workspaceId,
    );
    if (!source)
      throw new ApiError(403, 'Notification source does not belong to this bot and workspace.');
    this.database.run(
      `INSERT INTO bot_notifications(id,workspace_id,bot_id,bot_name,title,message,source_conversation_id,
       source_message_id,tool_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_message_id,tool_call_id) DO NOTHING`,
      randomUUID(),
      bot.workspaceId,
      bot.id,
      bot.name,
      input.title,
      input.message,
      String(source.conversation_id),
      messageId,
      toolCallId,
      new Date().toISOString(),
    );
    const row = this.database.get(
      'SELECT id FROM bot_notifications WHERE source_message_id=? AND tool_call_id=?',
      messageId,
      toolCallId,
    )!;
    return { notified: true, notificationId: String(row.id) };
  }
  list(workspaceId: string, offset = 0): NotificationInbox {
    const counts = this.database.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NULL),0) AS unread
       FROM bot_notifications WHERE workspace_id=? AND dismissed_at IS NULL`,
      workspaceId,
    )!;
    const items = this.database
      .all(
        `SELECT n.*, c.kind AS source_kind FROM bot_notifications n JOIN conversations c ON c.id=n.source_conversation_id
       WHERE n.workspace_id=? AND n.dismissed_at IS NULL ORDER BY n.created_at DESC,n.rowid DESC LIMIT 30 OFFSET ?`,
        workspaceId,
        offset,
      )
      .map((row) => this.project(row));
    return { items, total: Number(counts.total), unread: Number(counts.unread) };
  }
  mark(workspaceId: string, id: string, action: 'read' | 'dismiss') {
    this.require(workspaceId, id);
    this.database.run(
      `UPDATE bot_notifications SET ${action === 'read' ? 'read_at=COALESCE(read_at,?)' : 'dismissed_at=?'} WHERE id=?`,
      new Date().toISOString(),
      id,
    );
    return { ok: true };
  }
  dismissAll(workspaceId: string) {
    this.database.run(
      'UPDATE bot_notifications SET dismissed_at=? WHERE workspace_id=? AND dismissed_at IS NULL',
      new Date().toISOString(),
      workspaceId,
    );
    return { ok: true };
  }
  continue(workspaceId: string, id: string) {
    return this.database.transaction(() => {
      const notification = this.require(workspaceId, id);
      const conversations = new ConversationRepository(this.database);
      if (notification.conversationId) return conversations.find(notification.conversationId)!;
      const now = new Date().toISOString();
      const conversationId = randomUUID();
      this.database.run(
        `INSERT INTO conversations(id,workspace_id,kind,name,owner_bot_id,created_at,updated_at)
         VALUES(?,?,'private',?,?,?,?)`,
        conversationId,
        workspaceId,
        notification.title.slice(0, 60),
        notification.botId,
        now,
        now,
      );
      this.database.run(
        'INSERT INTO conversation_bots VALUES(?,?)',
        conversationId,
        notification.botId,
      );
      this.database.run(
        `INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,finished_at,conversation_id,author_name)
         VALUES(?,?,?,'assistant',?,'complete',?,?,?,?)`,
        randomUUID(),
        notification.botId,
        'notification-' + id,
        notification.message,
        now,
        now,
        conversationId,
        notification.botName,
      );
      this.database.run(
        'UPDATE bot_notifications SET conversation_id=?,read_at=COALESCE(read_at,?) WHERE id=?',
        conversationId,
        now,
        id,
      );
      return conversations.find(conversationId)!;
    });
  }
}
