import type { ModelMessage } from 'ai';
import type { ChatActivity, ContextUsage, ResponsePart } from '../../shared/ai';
import type { Database } from '../db/database';

export interface ChatCheckpoint {
  messages: ModelMessage[];
  usage: ContextUsage;
  steps: number;
  response?: {
    content: string;
    reasoning: string;
    parts: ResponsePart[];
    activity: ChatActivity[];
  };
}
export class ChatCheckpointError extends Error {}

// Checkpoints contain model context, never provider credentials or request headers.
export class ChatJobRepository {
  constructor(private database: Database) {}
  read(id: string, fingerprint: string): ChatCheckpoint | undefined {
    const row = this.database.get('SELECT * FROM chat_jobs WHERE message_id=?', id);
    if (!row || row.fingerprint !== fingerprint || row.in_flight) return;
    try {
      const value = JSON.parse(String(row.checkpoint_json)) as ChatCheckpoint;
      if (Array.isArray(value.messages) && value.usage && Number.isFinite(value.steps))
        return value;
    } catch {
      /* A damaged checkpoint cannot safely resume. */
    }
  }
  save(id: string, fingerprint: string, value: ChatCheckpoint) {
    const json = JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item,
    );
    if (Buffer.byteLength(json) > 32 * 1024 * 1024)
      throw new ChatCheckpointError(
        'The working context is too large to checkpoint safely. Completed work is saved; use a smaller model context or request.',
      );
    this.database.run(
      `INSERT INTO chat_jobs(message_id,checkpoint_json,fingerprint,in_flight,updated_at) VALUES(?,?,?,0,?)
       ON CONFLICT(message_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,fingerprint=excluded.fingerprint,in_flight=0,updated_at=excluded.updated_at`,
      id,
      json,
      fingerprint,
      new Date().toISOString(),
    );
  }
  beforeTool(id: string) {
    // Mark uncertainty BEFORE a side effect. A crash cannot cause an automatic replay.
    this.database.run('UPDATE chat_jobs SET in_flight=1 WHERE message_id=?', id);
  }
  accounting(id: string, usage: ContextUsage) {
    const row = this.database.get('SELECT checkpoint_json FROM chat_jobs WHERE message_id=?', id);
    if (!row) return;
    const checkpoint = JSON.parse(String(row.checkpoint_json)) as ChatCheckpoint;
    // Updating usage must never clear an uncertain operation or advance context.
    this.database.run(
      'UPDATE chat_jobs SET checkpoint_json=?,updated_at=? WHERE message_id=?',
      JSON.stringify({ ...checkpoint, usage }),
      new Date().toISOString(),
      id,
    );
  }
  remove(id: string) {
    this.database.run('DELETE FROM chat_jobs WHERE message_id=?', id);
  }
  context(conversationId: string, botId: string) {
    const row = this.database.get(
      'SELECT * FROM conversation_contexts WHERE conversation_id=? AND bot_id=?',
      conversationId,
      botId,
    );
    return row
      ? { summary: String(row.summary), throughSequence: Number(row.through_sequence) }
      : undefined;
  }
  saveContext(conversationId: string, botId: string, summary: string, throughSequence: number) {
    this.database.run(
      `INSERT INTO conversation_contexts VALUES(?,?,?,?) ON CONFLICT(conversation_id,bot_id)
       DO UPDATE SET summary=excluded.summary,through_sequence=excluded.through_sequence`,
      conversationId,
      botId,
      summary,
      throughSequence,
    );
  }
}
