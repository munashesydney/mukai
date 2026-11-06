import type {
  TrajectoryDetail,
  TrajectoryMessageStats,
  TrajectoryRecord,
} from '../../shared/trajectory';
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

  stats(conversationId: string): TrajectoryMessageStats[] {
    const rows = this.database.all(
      `WITH attempts AS (
         SELECT t.message_id, COALESCE(json_extract(t.summary_json,'$.modelStepId'), t.id) AS step_id,
           json_extract(t.summary_json,'$.usage.input') AS input,
           json_extract(t.summary_json,'$.usage.output') AS output,
           json_extract(t.summary_json,'$.usage.cached') AS cached,
           json_extract(t.summary_json,'$.lastTokenAt') IS NULL AS estimated,
           COALESCE(json_extract(t.summary_json,'$.lastTokenAt'), json_extract(t.summary_json,'$.finishedAt'))
             - json_extract(t.summary_json,'$.firstTokenAt') AS decode_ms
         FROM messages m JOIN chat_trajectory t ON t.message_id=m.id
         WHERE m.conversation_id=? AND json_extract(t.summary_json,'$.kind')='model'
       )
       SELECT message_id, COUNT(DISTINCT step_id) AS steps, SUM(input) AS input, SUM(output) AS output,
         SUM(CASE WHEN cached IS NOT NULL AND input > 0 THEN cached END) AS cached,
         SUM(CASE WHEN cached IS NOT NULL AND input > 0 THEN input END) AS cache_input,
         SUM(CASE WHEN output > 0 AND decode_ms > 0 THEN output END) AS timed_output,
         SUM(CASE WHEN output > 0 AND decode_ms > 0 THEN decode_ms END) AS decode_ms,
         MAX(CASE WHEN output > 0 AND decode_ms > 0 THEN estimated END) AS speed_estimated
       FROM attempts GROUP BY message_id`,
      conversationId,
    );
    return rows.map((row) => ({
      messageId: String(row.message_id),
      steps: Number(row.steps),
      input: typeof row.input === 'number' ? row.input : undefined,
      output: typeof row.output === 'number' ? row.output : undefined,
      cached: Number(row.cached ?? 0),
      cacheInput: Number(row.cache_input ?? 0),
      timedOutput: Number(row.timed_output ?? 0),
      decodeMs: Number(row.decode_ms ?? 0),
      speedEstimated: Boolean(row.speed_estimated),
    }));
  }

  interruptRunning() {
    this.database.run(
      `UPDATE chat_trajectory SET summary_json=json_set(summary_json,'$.status','interrupted')
       WHERE json_extract(summary_json,'$.status')='running'`,
    );
  }
}
