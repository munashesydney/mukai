import { randomUUID } from 'node:crypto';
import type { ChatActivity } from '../../shared/ai';
import type { ChatServerOutput } from '../../shared/chatActivity';
import type { Database, Row } from '../db/database';
import type { TerminalSnapshot } from '../../shared/terminal';

type SavedOutput = Omit<ChatServerOutput, 'status' | 'computer'>;
function output(row: Row): SavedOutput {
  return {
    id: String(row.id),
    botId: String(row.bot_id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    url: String(row.url),
  };
}
export class ChatOutputRepository {
  constructor(private db: Database) {}
  sources(conversationId: string) {
    return this.db
      .all(
        "SELECT id,bot_id,activity_json FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY sequence",
        conversationId,
      )
      .map((row) => ({
        messageId: String(row.id),
        botId: String(row.bot_id),
        activities: JSON.parse(String(row.activity_json || '[]')) as ChatActivity[],
      }));
  }
  save(conversationId: string, value: Omit<SavedOutput, 'id'>) {
    this.db.run(
      'INSERT OR IGNORE INTO conversation_server_outputs VALUES(?,?,?,?,?,?)',
      randomUUID(),
      conversationId,
      value.botId,
      value.messageId,
      value.sessionId,
      value.url,
    );
  }
  saveTerminal(
    conversationId: string,
    messageId: string,
    activityId: string,
    snapshot: TerminalSnapshot,
  ) {
    const row = this.db.get(
      "SELECT activity_json FROM messages WHERE id=? AND conversation_id=? AND role='assistant'",
      messageId,
      conversationId,
    );
    if (!row) return;
    const activities = JSON.parse(String(row.activity_json || '[]')) as ChatActivity[];
    const activity = activities.find(
      (item) => item.id === activityId && item.processSessionId === snapshot.id,
    );
    if (!activity || JSON.stringify(activity.terminal) === JSON.stringify(snapshot)) return;
    activity.terminal = snapshot;
    this.db.run(
      'UPDATE messages SET activity_json=? WHERE id=? AND conversation_id=?',
      JSON.stringify(activities),
      messageId,
      conversationId,
    );
  }
  list(conversationId: string) {
    return this.db
      .all(
        'SELECT * FROM conversation_server_outputs WHERE conversation_id=? ORDER BY rowid',
        conversationId,
      )
      .map(output);
  }
  find(conversationId: string, outputId: string) {
    const row = this.db.get(
      'SELECT * FROM conversation_server_outputs WHERE id=? AND conversation_id=?',
      outputId,
      conversationId,
    );
    return row ? output(row) : undefined;
  }
}
