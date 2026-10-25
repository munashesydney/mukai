import type { FileArtifact } from '../../shared/ai';
import type { Database, Row } from '../db/database';
import type { FileMetadata } from '../../shared/fileMetadata';

const artifactRecord = (row: Row): FileArtifact => ({
  id: String(row.id),
  botId: String(row.bot_id),
  messageId: String(row.message_id),
  path: String(row.path),
  name: String(row.name),
  createdAt: String(row.created_at),
  ...(row.kind === 'image' ? { kind: 'image' as const, mediaType: 'image/png' } : {}),
  ...(row.media_type ? { mediaType: String(row.media_type) } : {}),
  ...(row.size !== null && row.size !== undefined ? { size: Number(row.size) } : {}),
});
export class ArtifactRepository {
  constructor(private database: Database) {}
  list(botId: string) {
    return this.database
      .all(
        'SELECT * FROM artifacts WHERE conversation_id=? ORDER BY created_at DESC',
        'bot-' + botId,
      )
      .map(artifactRecord);
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM artifacts WHERE id=?', id);
    return row ? artifactRecord(row) : undefined;
  }
  forConversation(id: string) {
    return this.database
      .all('SELECT * FROM artifacts WHERE conversation_id=? ORDER BY created_at DESC', id)
      .map(artifactRecord);
  }
  save(file: FileArtifact) {
    const row = this.database.get(
      'INSERT INTO artifacts(id,bot_id,message_id,path,name,created_at,conversation_id,kind,media_type,size) VALUES (?,?,?,?,?,?,(SELECT conversation_id FROM messages WHERE id=?),?,?,?) ON CONFLICT(conversation_id,path) DO UPDATE SET bot_id=excluded.bot_id,message_id=excluded.message_id,created_at=excluded.created_at,kind=excluded.kind,media_type=excluded.media_type,size=excluded.size RETURNING *',
      file.id,
      file.botId,
      file.messageId,
      file.path,
      file.name,
      file.createdAt,
      file.messageId,
      file.kind || 'file',
      file.mediaType || (file.kind === 'image' ? 'image/png' : null),
      file.size ?? null,
    );
    return artifactRecord(row!);
  }
  updateMetadata(id: string, metadata: FileMetadata) {
    this.database.run(
      'UPDATE artifacts SET media_type=?,size=? WHERE id=?',
      metadata.mediaType,
      metadata.size,
      id,
    );
  }
}
