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
    return this.database
      .all(
        `SELECT * FROM attachments WHERE bot_id = ? AND message_id IS ${pending ? '' : 'NOT '}NULL`,
        botId,
      )
      .map(attachmentRecord);
  }
  forMessage(id: string) {
    return this.database
      .all('SELECT * FROM attachments WHERE message_id = ?', id)
      .map(attachmentRecord);
  }
  forConversation(id: string) {
    return this.database
      .all(
        'SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=?',
        id,
      )
      .map(attachmentRecord);
  }
  pendingCount(botId: string) {
    return Number(
      this.database.get(
        'SELECT COUNT(*) AS count FROM attachments WHERE bot_id = ? AND message_id IS NULL',
        botId,
      )?.count,
    );
  }
  storageNames(botId: string) {
    return this.database
      .all('SELECT storage_name FROM attachments WHERE bot_id = ?', botId)
      .map((row) => String(row.storage_name));
  }
  create(file: AttachmentRecord) {
    this.database.run(
      'INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?,?)',
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
    );
  }
  delete(id: string) {
    this.database.run('DELETE FROM attachments WHERE id = ?', id);
  }
}
