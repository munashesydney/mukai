import type { Database } from '../db/database';
import type { AttachmentRecord } from '../models/entities';
import { attachmentRecord } from './records';

export class AttachmentRepository {
  constructor(private database: Database) {}
  find(id: string) {
    const row = this.database.get('SELECT * FROM attachments WHERE id = ?', id);
    return row ? attachmentRecord(row) : undefined;
  }
  forBot(botId: string, pending: boolean) {
    if (pending) return this.pending('bot-' + botId);
    return this.database
      .all(
        `SELECT * FROM attachments WHERE bot_id = ? AND (message_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM followup_attachments fa JOIN chat_followups f ON f.id=fa.followup_id
          WHERE fa.attachment_id=attachments.id AND f.state='applied'))`,
        botId,
      )
      .map(attachmentRecord);
  }
  forMessage(id: string) {
    return this.database
      .all(
        `SELECT a.* FROM attachments a LEFT JOIN followup_attachments fa ON fa.attachment_id=a.id
        WHERE a.message_id = ? ORDER BY COALESCE(fa.position,a.rowid)`,
        id,
      )
      .map(attachmentRecord);
  }
  pending(conversationId: string) {
    return this.database
      .all(
        `SELECT * FROM attachments WHERE conversation_id=? AND message_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM followup_attachments fa WHERE fa.attachment_id=attachments.id)`,
        conversationId,
      )
      .map(attachmentRecord);
  }
  forConversation(id: string) {
    return this.database
      .all(
        `SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id
          LEFT JOIN followup_attachments fa ON fa.attachment_id=a.id
          WHERE m.conversation_id=? ORDER BY m.sequence,COALESCE(fa.position,a.rowid)`,
        id,
      )
      .map(attachmentRecord);
  }
  pendingCount(botId: string, conversationId = 'bot-' + botId) {
    return Number(
      this.database.get(
        `SELECT COUNT(*) AS count FROM attachments WHERE conversation_id = ? AND message_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM followup_attachments fa WHERE fa.attachment_id=attachments.id)`,
        conversationId,
      )?.count,
    );
  }
  storageNames(botId: string) {
    return this.database
      .all('SELECT storage_name FROM attachments WHERE bot_id = ?', botId)
      .map((row) => String(row.storage_name));
  }
  followupOwner(id: string) {
    return this.database.get(
      'SELECT followup_id FROM followup_attachments WHERE attachment_id=?',
      id,
    )?.followup_id;
  }
  forFollowup(id: string) {
    return this.database
      .all(
        `SELECT a.* FROM attachments a JOIN followup_attachments fa
      ON fa.attachment_id=a.id WHERE fa.followup_id=? ORDER BY fa.position`,
        id,
      )
      .map(attachmentRecord);
  }
  create(file: AttachmentRecord) {
    this.database.run(
      'INSERT INTO attachments(id,bot_id,message_id,name,media_type,size,kind,storage_name,extracted_text,warning,conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      file.id,
      file.botId,
      file.messageId,
      file.name,
      file.mediaType,
      file.size,
      file.kind,
      file.storageName,
      file.extractedText,
      file.warning,
      file.conversationId,
    );
  }
  delete(id: string) {
    this.database.run('DELETE FROM attachments WHERE id = ?', id);
  }
}
