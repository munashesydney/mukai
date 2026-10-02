import type { Database } from '../db/database';
import type { ChatActivity, MessageStatus } from '../../shared/ai';
import type { MessageRecord } from '../models/entities';
import { publicMessage } from '../models/entities';
import { AttachmentRepository } from './attachmentRepository';
import { messageRecord } from './records';

export class MessageRepository {
  constructor(
    private database: Database,
    private attachments: AttachmentRepository,
  ) {}
  history(botId: string) {
    const files = this.attachments.forBot(botId, false);
    return this.database
      .all('SELECT * FROM messages WHERE bot_id = ? ORDER BY sequence', botId)
      .map((row) => {
        const message = messageRecord(row);
        return publicMessage(
          message,
          files.filter((file) => file.messageId === message.id),
        );
      });
  }
  message(id: string) {
    const row = this.database.get('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw new Error('Message not found');
    return publicMessage(messageRecord(row), this.attachments.forMessage(id));
  }
  forRequest(botId: string, requestId: string, role: MessageRecord['role']) {
    const row = this.database.get(
      'SELECT * FROM messages WHERE bot_id = ? AND request_id = ? AND role = ?',
      botId,
      requestId,
      role,
    );
    return row ? messageRecord(row) : undefined;
  }
  latestUserId(botId: string) {
    return this.database.get(
      "SELECT id FROM messages WHERE bot_id = ? AND role = 'user' ORDER BY sequence DESC LIMIT 1",
      botId,
    )?.id;
  }
  context(botId: string, limit: number) {
    return this.database
      .all(
        "SELECT * FROM messages WHERE bot_id = ? AND status != 'streaming' AND (role = 'user' OR content != '') ORDER BY sequence DESC LIMIT ?",
        botId,
        limit,
      )
      .reverse()
      .map(messageRecord);
  }
  interruptStreaming(error: string, botId?: string) {
    const pending = this.database.all(
      `SELECT * FROM messages WHERE status='streaming'${botId === undefined ? '' : ' AND bot_id=?'}`,
      ...(botId === undefined ? [] : [botId]),
    );
    for (const row of pending) {
      const activity = (messageRecord(row).activity || []).map((item) =>
        item.status === 'running'
          ? {
              ...item,
              status: 'interrupted',
              summary: 'The response was interrupted before this operation finished.',
            }
          : item,
      );
      this.database.run(
        'UPDATE messages SET activity_json=? WHERE id=?',
        JSON.stringify(activity),
        row.id,
      );
    }
    this.database.run(
      `UPDATE messages SET status = 'interrupted', error = ? WHERE status = 'streaming'${botId === undefined ? '' : ' AND bot_id = ?'}`,
      error,
      ...(botId === undefined ? [] : [botId]),
    );
  }
  reset(id: string) {
    this.database.run(
      "UPDATE messages SET content = '', reasoning = '', status = 'streaming', error = NULL WHERE id = ?",
      id,
    );
  }
  saveProgress(id: string, content: string, reasoning: string, activity: ChatActivity[]) {
    this.database.run(
      'UPDATE messages SET content = ?,reasoning=?,activity_json=? WHERE id = ?',
      content,
      reasoning,
      JSON.stringify(activity),
      id,
    );
  }
  finish(
    id: string,
    content: string,
    status: MessageStatus,
    error: string | null,
    reasoning: string,
    activity: ChatActivity[],
  ) {
    this.database.run(
      'UPDATE messages SET content = ?, status = ?, error = ?,reasoning=?,activity_json=? WHERE id = ?',
      content,
      status,
      error,
      reasoning,
      JSON.stringify(activity),
      id,
    );
  }
  toolCounts(workspaceId: string) {
    const counts: Record<string, Record<string, number>> = {};
    const rows = this.database.all(
      'SELECT activity_json FROM messages JOIN bots ON bots.id=messages.bot_id WHERE bots.workspace_id=? ORDER BY sequence DESC LIMIT 5000',
      workspaceId,
    );
    for (const row of rows) {
      for (const activity of JSON.parse(String(row.activity_json)) as ChatActivity[]) {
        if (activity.status !== 'complete') continue;
        counts[activity.tool] ??= {};
        counts[activity.tool][activity.action] = (counts[activity.tool][activity.action] || 0) + 1;
      }
    }
    return counts;
  }
  createTurn(input: {
    botId: string;
    requestId: string;
    userId: string;
    assistantId: string;
    text: string;
    attachmentIds: string[];
  }) {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const role of ['user', 'assistant'] as const) {
        this.database.run(
          'INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)',
          role === 'user' ? input.userId : input.assistantId,
          input.botId,
          input.requestId,
          role,
          role === 'user' ? input.text : '',
          role === 'user' ? 'complete' : 'streaming',
          now,
        );
      }
      for (const id of input.attachmentIds) {
        this.database.run('UPDATE attachments SET message_id = ? WHERE id = ?', input.userId, id);
      }
    });
  }
}
