import type { ChatFollowup } from '../../shared/ai';
import type { Database, Row } from '../db/database';
import { ApiError } from '../config';
import { AttachmentRepository } from './attachmentRepository';
import { publicAttachment } from '../models/entities';

function followup(row: Row): ChatFollowup {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    botId: String(row.bot_id),
    text: String(row.text),
    state: row.state as ChatFollowup['state'],
    targetMessageId: row.target_message_id === null ? null : String(row.target_message_id),
    createdAt: String(row.created_at),
    error: row.error === null ? null : String(row.error),
  };
}

export class ChatFollowupRepository {
  constructor(private database: Database) {}
  exists(id: string) {
    return !!this.database.get('SELECT id FROM chat_followups WHERE id=?', id);
  }
  private project = (row: Row): ChatFollowup => {
    const attachments = new AttachmentRepository(this.database)
      .forFollowup(String(row.id))
      .map(publicAttachment);
    return { ...followup(row), ...(attachments.length ? { attachments } : {}) };
  };
  list(conversationId: string) {
    return this.database
      .all(
        "SELECT * FROM chat_followups WHERE conversation_id=? AND state IN ('queued','steering','sending') ORDER BY sequence",
        conversationId,
      )
      .map(this.project);
  }
  require(conversationId: string, id: string) {
    const row = this.database.get(
      'SELECT * FROM chat_followups WHERE conversation_id=? AND id=?',
      conversationId,
      id,
    );
    if (!row) throw new ApiError(404, 'Follow-up not found in this conversation.');
    return this.project(row);
  }
  enqueue(
    conversationId: string,
    botId: string,
    id: string,
    text: string,
    attachmentIds: string[] = [],
  ) {
    const previous = this.database.get('SELECT * FROM chat_followups WHERE id=?', id);
    if (previous) {
      if (
        previous.conversation_id !== conversationId ||
        previous.bot_id !== botId ||
        previous.text !== text ||
        JSON.stringify(
          new AttachmentRepository(this.database).forFollowup(id).map((file) => file.id),
        ) !== JSON.stringify(attachmentIds)
      )
        throw new ApiError(409, 'This follow-up ID already belongs to a different message.');
      return this.project(previous);
    }
    if (this.list(conversationId).length >= 20)
      throw new ApiError(400, 'Queue up to twenty follow-ups per chat.');
    this.database.transaction(() => {
      this.database.run(
        "INSERT INTO chat_followups(id,conversation_id,bot_id,text,state,created_at) VALUES(?,?,?,?,'queued',?)",
        id,
        conversationId,
        botId,
        text,
        new Date().toISOString(),
      );
      attachmentIds.forEach((attachmentId, position) =>
        this.database.run(
          'INSERT INTO followup_attachments VALUES(?,?,?)',
          id,
          attachmentId,
          position,
        ),
      );
    });
    return this.require(conversationId, id);
  }
  state(
    conversationId: string,
    id: string,
    state: ChatFollowup['state'],
    target: string | null = null,
    error: string | null = null,
  ) {
    this.database.run(
      `UPDATE chat_followups SET state=?,target_message_id=?,error=?,
      steering_order=CASE WHEN ?='steering' THEN COALESCE(steering_order,(SELECT COALESCE(MAX(steering_order),0)+1 FROM chat_followups)) ELSE steering_order END
      WHERE conversation_id=? AND id=?`,
      state,
      target,
      error,
      state,
      conversationId,
      id,
    );
  }
  edit(conversationId: string, id: string, text: string, attachmentIds?: string[]) {
    if (this.require(conversationId, id).state !== 'queued')
      throw new ApiError(409, 'Only queued messages can be edited.');
    const removed: string[] = [];
    this.database.transaction(() => {
      if (attachmentIds) {
        const files = new AttachmentRepository(this.database).forFollowup(id);
        this.database.run('DELETE FROM followup_attachments WHERE followup_id=?', id);
        for (const file of files) {
          if (attachmentIds.includes(file.id)) continue;
          this.database.run('DELETE FROM attachments WHERE id=? AND message_id IS NULL', file.id);
          removed.push(file.storageName);
        }
        attachmentIds.forEach((attachmentId, position) =>
          this.database.run(
            'INSERT INTO followup_attachments VALUES(?,?,?)',
            id,
            attachmentId,
            position,
          ),
        );
      }
      this.database.run(
        'UPDATE chat_followups SET text=?,error=NULL WHERE conversation_id=? AND id=?',
        text,
        conversationId,
        id,
      );
    });
    return removed;
  }
  cancel(conversationId: string, id: string) {
    const files = new AttachmentRepository(this.database).forFollowup(id);
    this.database.transaction(() => {
      this.state(conversationId, id, 'cancelled');
      for (const file of files)
        this.database.run('DELETE FROM attachments WHERE id=? AND message_id IS NULL', file.id);
    });
    return files.filter((file) => !file.messageId).map((file) => file.storageName);
  }
  forMessage(id: string, state: 'steering' | 'applied') {
    return this.database
      .all(
        'SELECT * FROM chat_followups WHERE target_message_id=? AND state=? ORDER BY steering_order,sequence',
        id,
        state,
      )
      .map(this.project);
  }
  commitApplied(items: ChatFollowup[], save: () => void) {
    // The working checkpoint and delivery receipts must advance together.
    this.database.transaction(() => {
      save();
      for (const item of items)
        this.database.run(
          "UPDATE chat_followups SET state='applied' WHERE id=? AND state='steering'",
          item.id,
        );
    });
  }
  releaseSteering(messageId: string) {
    this.database.run(
      "UPDATE chat_followups SET state='queued',target_message_id=NULL,steering_order=NULL WHERE target_message_id=? AND state='steering'",
      messageId,
    );
  }
  pause(conversationId: string) {
    this.database.run(
      `INSERT INTO chat_followup_queues VALUES(?,1)
      ON CONFLICT(conversation_id) DO UPDATE SET paused=1`,
      conversationId,
    );
  }
  resume(conversationId: string) {
    this.database.run('DELETE FROM chat_followup_queues WHERE conversation_id=?', conversationId);
  }
  paused(conversationId: string) {
    return Boolean(
      this.database.get(
        'SELECT paused FROM chat_followup_queues WHERE conversation_id=?',
        conversationId,
      )?.paused,
    );
  }
  recover() {
    this.database.run(`UPDATE chat_followups SET state=CASE
      WHEN EXISTS(SELECT 1 FROM messages WHERE request_id=chat_followups.id AND conversation_id=chat_followups.conversation_id AND role='user') THEN 'sent'
      ELSE 'queued' END WHERE state='sending'`);
    this.database
      .run(`UPDATE chat_followups SET state='queued',target_message_id=NULL,steering_order=NULL
      WHERE state='steering' AND target_message_id IN (SELECT id FROM messages WHERE status!='streaming')`);
  }
  runnableConversations() {
    return this.database
      .all(
        `SELECT DISTINCT f.conversation_id FROM chat_followups f
      WHERE f.state='queued' AND f.error IS NULL AND
      NOT EXISTS(SELECT 1 FROM chat_followup_queues q WHERE q.conversation_id=f.conversation_id AND q.paused=1) AND
      COALESCE((SELECT status FROM messages m WHERE m.conversation_id=f.conversation_id AND role='assistant' ORDER BY sequence DESC LIMIT 1),'complete')='complete'`,
      )
      .map((row) => String(row.conversation_id));
  }
}
