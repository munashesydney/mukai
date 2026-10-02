import { randomUUID } from 'node:crypto';
import type {
  FileChangeDetail,
  FileChangeSummary,
  FileMutationSnapshot,
} from '../../shared/fileChanges';
import type { Database, Row } from '../db/database';
import { fileDiff } from '../fileDiff';

function summary(row: Row): FileChangeSummary {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    path: String(row.path),
    kind: row.before_text === null ? 'created' : 'edited',
    added: row.added as number | null,
    removed: row.removed as number | null,
  };
}
export class FileChangeRepository {
  constructor(private database: Database) {}
  forBot(botId: string) {
    return this.database
      .all(
        'SELECT id,message_id,path,added,removed,CASE WHEN before_text IS NULL THEN NULL ELSE 1 END AS before_text FROM file_changes WHERE bot_id=? ORDER BY rowid',
        botId,
      )
      .map(summary);
  }
  forMessage(messageId: string) {
    return this.database
      .all(
        'SELECT id,message_id,path,added,removed,CASE WHEN before_text IS NULL THEN NULL ELSE 1 END AS before_text FROM file_changes WHERE message_id=? ORDER BY rowid',
        messageId,
      )
      .map(summary);
  }
  forConversation(id: string) {
    return this.database
      .all(
        'SELECT f.id,f.message_id,f.path,f.added,f.removed,CASE WHEN f.before_text IS NULL THEN NULL ELSE 1 END AS before_text FROM file_changes f JOIN messages m ON m.id=f.message_id WHERE m.conversation_id=? ORDER BY f.rowid',
        id,
      )
      .map(summary);
  }
  find(id: string): FileChangeDetail | undefined {
    const row = this.database.get('SELECT * FROM file_changes WHERE id=?', id);
    return row
      ? {
          ...summary(row),
          before: row.before_text as string | null,
          after: String(row.after_text),
          hunks: row.hunks_json === null ? null : JSON.parse(String(row.hunks_json)),
        }
      : undefined;
  }
  record(botId: string, messageId: string, snapshot: FileMutationSnapshot) {
    // Windows identifies files without case sensitivity. Retain the first display spelling.
    const key = process.platform === 'win32' ? snapshot.path.toLowerCase() : snapshot.path;
    const previous = this.database.get(
      'SELECT * FROM file_changes WHERE message_id=? AND path_key=?',
      messageId,
      key,
    );
    const before = previous ? (previous.before_text as string | null) : snapshot.before;
    if (before === snapshot.after) {
      if (previous) this.database.run('DELETE FROM file_changes WHERE id=?', previous.id);
      return;
    }
    const path = previous ? String(previous.path) : snapshot.path;
    const diff = fileDiff(path, before, snapshot.after);
    this.database.run(
      'INSERT INTO file_changes(id,message_id,bot_id,path,path_key,before_text,after_text,added,removed,hunks_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,path_key) DO UPDATE SET after_text=excluded.after_text,added=excluded.added,removed=excluded.removed,hunks_json=excluded.hunks_json',
      previous ? String(previous.id) : randomUUID(),
      messageId,
      botId,
      path,
      key,
      before,
      snapshot.after,
      diff.added,
      diff.removed,
      diff.hunks === null ? null : JSON.stringify(diff.hunks),
    );
  }
}
