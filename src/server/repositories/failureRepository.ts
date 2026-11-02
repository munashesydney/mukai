import type { FailureInbox } from '../../shared/failures';
import { ApiError } from '../config';
import type { Database } from '../db/database';
import { ConversationRepository } from './conversationRepository';

// Only the current response counts. Historical errors remain in history, not in this inbox.
const failures = `SELECT c.id, c.workspace_id, w.name AS workspace_name,
  COALESCE(b.name,'Bot') AS bot_name, r.pursuit_id, r.id AS run_id,
  COALESCE(r.finished_at,m.finished_at,m.created_at,c.updated_at) AS failed_at,
  COALESCE(r.error,m.error,'The response was interrupted. Saved progress is available in the chat.') AS error
 FROM conversations c JOIN workspaces w ON w.id=c.workspace_id
 LEFT JOIN messages m ON m.id=(SELECT id FROM messages WHERE conversation_id=c.id
   AND role='assistant' ORDER BY sequence DESC LIMIT 1)
 LEFT JOIN pursuit_runs r ON r.conversation_id=c.id
 LEFT JOIN bots b ON b.id=COALESCE(m.bot_id,c.owner_bot_id,json_extract(r.snapshot_json,'$.ownerBotId'))
 LEFT JOIN chat_failure_dismissals d ON d.conversation_id=c.id
 WHERE d.conversation_id IS NULL AND (
   (c.kind<>'pursuit_run' AND m.status IN ('failed','interrupted') AND m.request_id=
     (SELECT request_id FROM messages WHERE conversation_id=c.id AND role='user' ORDER BY sequence DESC LIMIT 1))
   OR (c.kind='pursuit_run' AND r.status IN ('failed','interrupted'))
 )`;

export class FailureRepository {
  constructor(private database: Database) {}
  list(offset = 0): FailureInbox {
    const conversations = new ConversationRepository(this.database);
    return {
      total: Number(this.database.get(`SELECT COUNT(*) AS total FROM (${failures})`)!.total),
      items: this.database
        .all(`${failures} ORDER BY failed_at DESC,c.id LIMIT 30 OFFSET ?`, offset)
        .map((row) => ({
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          workspaceName: String(row.workspace_name),
          botName: String(row.bot_name),
          failedAt: String(row.failed_at),
          error: String(row.error),
          conversation: conversations.find(String(row.id))!,
          ...(row.run_id ? { runId: String(row.run_id), pursuitId: String(row.pursuit_id) } : {}),
        })),
    };
  }
  dismiss(id: string) {
    if (!this.database.get('SELECT id FROM conversations WHERE id=?', id))
      throw new ApiError(404, 'Conversation not found.');
    this.database.run(
      'INSERT OR REPLACE INTO chat_failure_dismissals VALUES(?,?)',
      id,
      new Date().toISOString(),
    );
    return { ok: true };
  }
  dismissAll() {
    this.database.run(
      `INSERT OR REPLACE INTO chat_failure_dismissals(conversation_id,dismissed_at)
      SELECT id,? FROM (${failures})`,
      new Date().toISOString(),
    );
    return { ok: true };
  }
}
