import type { FileArtifact } from '../../shared/ai';
import type { Database, Row } from '../db/database';

const artifactRecord = (row: Row): FileArtifact => ({
  id: String(row.id),
  botId: String(row.bot_id),
  messageId: String(row.message_id),
  path: String(row.path),
  name: String(row.name),
  createdAt: String(row.created_at),
});
export class ArtifactRepository {
  constructor(private database: Database) {}
  list(botId: string) {
    return this.database
      .all('SELECT * FROM artifacts WHERE bot_id=? ORDER BY created_at DESC', botId)
      .map(artifactRecord);
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM artifacts WHERE id=?', id);
    return row ? artifactRecord(row) : undefined;
  }
  save(file: FileArtifact) {
    this.database.run(
      'INSERT INTO artifacts VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id,path) DO UPDATE SET message_id=excluded.message_id,created_at=excluded.created_at',
      file.id,
      file.botId,
      file.messageId,
      file.path,
      file.name,
      file.createdAt,
    );
  }
}
