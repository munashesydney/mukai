import type { TrajectoryDetail, TrajectoryRecord } from '../../shared/trajectory';
import type { Database } from '../db/database';

type Summary = Omit<TrajectoryRecord, 'id' | 'messageId'>;

export class TrajectoryRepository {
  constructor(private database: Database) {}

  start(messageId: string, summary: Summary, detail: TrajectoryDetail) {
    return Number(
      this.database.run(
        'INSERT INTO chat_trajectory(message_id,summary_json,detail_json) VALUES(?,?,?)',
        messageId,
        JSON.stringify(summary),
        JSON.stringify(detail),
      ).lastInsertRowid,
    );
  }

  update(id: number, summary: Summary, detail: TrajectoryDetail) {
    this.database.run(
      'UPDATE chat_trajectory SET summary_json=?,detail_json=? WHERE id=?',
      JSON.stringify(summary),
      JSON.stringify(detail),
      id,
    );
  }

  list(conversationId: string, fromMessageId?: string): TrajectoryRecord[] {
    return this.database
      .all(
        `SELECT t.id,t.message_id,t.summary_json FROM messages m
         JOIN chat_trajectory t ON t.message_id=m.id WHERE m.conversation_id=?
         AND (? IS NULL OR m.sequence >= (SELECT sequence FROM messages WHERE id=? AND conversation_id=?))
         ORDER BY t.id`,
        conversationId,
        fromMessageId ?? null,
        fromMessageId ?? null,
        conversationId,
      )
      .map((row) => ({
        ...(JSON.parse(String(row.summary_json)) as Summary),
        id: Number(row.id),
        messageId: String(row.message_id),
      }));
  }

  detail(conversationId: string, id: number): TrajectoryDetail | undefined {
    const row = this.database.get(
      `SELECT t.detail_json FROM chat_trajectory t JOIN messages m ON m.id=t.message_id
       WHERE t.id=? AND m.conversation_id=?`,
      id,
      conversationId,
    );
    return row ? (JSON.parse(String(row.detail_json)) as TrajectoryDetail) : undefined;
  }

  interruptRunning() {
    this.database.run(
      `UPDATE chat_trajectory SET summary_json=json_set(summary_json,'$.status','interrupted')
       WHERE json_extract(summary_json,'$.status')='running'`,
    );
  }
}
