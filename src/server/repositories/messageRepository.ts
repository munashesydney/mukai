import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database';
import type { ChatActivity, MessageStatus, ResponsePart } from '../../shared/ai';
import type { MessageRecord } from '../models/entities';
import { publicMessage } from '../models/entities';
import { AttachmentRepository } from './attachmentRepository';
import { messageRecord } from './records';
import { FileChangeRepository } from './fileChangeRepository';

export class MessageRepository {
  constructor(
    private database: Database,
    private attachments: AttachmentRepository,
    private changes: FileChangeRepository,
  ) {}
  history(conversationId: string) {
    const files = this.attachments.forConversation(conversationId);
    const changes = this.changes.forConversation(conversationId);
    return this.database
      .all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence', conversationId)
      .map((row) => {
        const message = messageRecord(row);
        return {
          ...publicMessage(
            message,
            files.filter((file) => file.messageId === message.id),
          ),
          changes: changes.filter((change) => change.messageId === message.id),
        };
      });
  }
  message(id: string) {
    const row = this.database.get('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw new Error('Message not found');
    return {
      ...publicMessage(messageRecord(row), this.attachments.forMessage(id)),
      changes: this.changes.forMessage(id),
    };
  }
  forRequest(conversationId: string, requestId: string, role: MessageRecord['role']) {
    const row = this.database.get(
      'SELECT * FROM messages WHERE conversation_id = ? AND request_id = ? AND role = ?',
      conversationId,
      requestId,
      role,
    );
    return row ? messageRecord(row) : undefined;
  }
  latestUserId(conversationId: string) {
    return this.database.get(
      "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY sequence DESC LIMIT 1",
      conversationId,
    )?.id;
  }
  context(conversationId: string, limit: number, throughSequence: number) {
    return this.database
      .all(
        "SELECT * FROM messages WHERE conversation_id = ? AND sequence <= ? AND status = 'complete' AND (role = 'user' OR content != '') ORDER BY sequence DESC LIMIT ?",
        conversationId,
        throughSequence,
        limit,
      )
      .reverse()
      .map(messageRecord);
  }
  privateConversation(id: string) {
    return this.database.get('SELECT kind FROM conversations WHERE id=?', id)?.kind === 'private';
  }
  interruptStreaming(error: string, conversationId?: string) {
    const pending = this.database.all(
      `SELECT * FROM messages WHERE status='streaming'${conversationId === undefined ? '' : ' AND conversation_id=?'}`,
      ...(conversationId === undefined ? [] : [conversationId]),
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
      `UPDATE messages SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = ? WHERE status = 'streaming'${conversationId === undefined ? '' : ' AND conversation_id = ?'}`,
      error,
      ...(conversationId === undefined ? [] : [conversationId]),
    );
  }
  reset(id: string) {
    this.database.run(
      "UPDATE messages SET content = '', reasoning = '', parts_json = '[]', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), finished_at = NULL, status = 'streaming', error = NULL WHERE id = ?",
      id,
    );
  }
  saveProgress(
    id: string,
    content: string,
    reasoning: string,
    activity: ChatActivity[],
    parts: ResponsePart[] = [],
  ) {
    this.database.run(
      'UPDATE messages SET content = ?,reasoning=?,activity_json=?,parts_json=? WHERE id = ?',
      content,
      reasoning,
      JSON.stringify(activity),
      JSON.stringify(parts),
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
    parts: ResponsePart[] = [],
  ) {
    this.database.run(
      "UPDATE messages SET content = ?, status = ?, error = ?,reasoning=?,activity_json=?,parts_json=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      content,
      status,
      error,
      reasoning,
      JSON.stringify(activity),
      JSON.stringify(parts),
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
  createUser(conversationId: string, requestId: string, text: string) {
    const id = randomUUID();
    this.database.run(
      'INSERT INTO messages(id,conversation_id,request_id,role,content,status,created_at,author_name) VALUES(?,?,?,?,?,?,?,?)',
      id,
      conversationId,
      requestId,
      'user',
      text,
      'complete',
      new Date().toISOString(),
      'You',
    );
    return this.message(id);
  }
  setSaved(conversationId: string, id: string, saved: boolean) {
    const row = this.database.get(
      'SELECT id FROM messages WHERE id=? AND conversation_id=?',
      id,
      conversationId,
    );
    if (!row) return false;
    this.database.run('UPDATE messages SET saved=? WHERE id=?', Number(saved), id);
    return true;
  }
  sequence(id: string) {
    return Number(this.database.get('SELECT sequence FROM messages WHERE id=?', id)?.sequence);
  }
  createTurn(input: {
    botId: string;
    conversationId: string;
    authorName: string;
    requestId: string;
    userId: string;
    assistantId: string;
    text: string;
    attachmentIds: string[];
  }) {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      if (
        this.privateConversation(input.conversationId) &&
        !this.latestUserId(input.conversationId)
      ) {
        const name = input.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Shared files';
        this.database.run('UPDATE conversations SET name=? WHERE id=?', name, input.conversationId);
      }
      for (const role of ['user', 'assistant'] as const) {
        this.database.run(
          'INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,started_at,conversation_id,author_name) VALUES (?,?,?,?,?,?,?,?,?,?)',
          role === 'user' ? input.userId : input.assistantId,
          input.botId,
          input.requestId,
          role,
          role === 'user' ? input.text : '',
          role === 'user' ? 'complete' : 'streaming',
          now,
          role === 'assistant' ? now : null,
          input.conversationId,
          role === 'user' ? 'You' : input.authorName,
        );
      }
      for (const id of input.attachmentIds) {
        this.database.run('UPDATE attachments SET message_id = ? WHERE id = ?', input.userId, id);
      }
    });
  }
}
