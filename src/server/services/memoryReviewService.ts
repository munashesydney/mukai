import { randomUUID } from 'node:crypto';
import type {
  MemoryEngine,
  SQLiteMemoryStore,
  MemoryScope,
  SearchHit,
} from '../../../mukai_memory/src';
import { redactCredentials } from '../../../mukai_memory/src';
import type { BotRepository } from '../repositories/botRepository';
import type { MemoryReviewRun } from '../../shared/memory';
import { ApiError } from '../config';

/** Durable, conversation-scoped review queue. No bot account or general-purpose tools. */
export class MemoryReviewService {
  private processing?: Promise<string[]>;
  constructor(
    private store: SQLiteMemoryStore,
    private engine: MemoryEngine,
    private bots: BotRepository,
    private enabled: (workspaceId: string) => boolean,
    private idleMs = 60000,
    private search?: (scope: MemoryScope, query: string) => Promise<SearchHit[]>,
  ) {}

  schedule(workspaceId: string, conversationId: string, actorId: string) {
    if (!this.enabled(workspaceId)) return;
    this.store.run(
      `INSERT INTO memory_review_jobs(conversation_id,workspace_id,actor_id,due_at)
      VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET actor_id=excluded.actor_id,
      due_at=excluded.due_at`,
      conversationId,
      workspaceId,
      actorId,
      Date.now() + this.idleMs,
    );
  }
  recover() {
    this.store.run(
      "UPDATE memory_review_runs SET status='failed',error='Mukai stopped during this review. Retry to continue.',finished_at=? WHERE status='running'",
      new Date().toISOString(),
    );
    // Discover messages persisted before a crash, including spaces without a bot response.
    for (const row of this.store.all(`SELECT c.id,c.workspace_id,COALESCE(c.owner_bot_id,
      (SELECT bot_id FROM messages WHERE conversation_id=c.id AND role='assistant' ORDER BY sequence DESC LIMIT 1),
      (SELECT bot_id FROM conversation_bots WHERE conversation_id=c.id LIMIT 1)) AS actor_id
      FROM conversations c WHERE EXISTS(SELECT 1 FROM messages WHERE conversation_id=c.id)`)) {
      if (
        row.actor_id &&
        !this.store.get(
          'SELECT conversation_id FROM memory_review_jobs WHERE conversation_id=?',
          String(row.id),
        )
      )
        this.schedule(String(row.workspace_id), String(row.id), String(row.actor_id));
    }
  }
  list(workspaceId: string): MemoryReviewRun[] {
    // Only redact runs whose recorded fact references were actually removed.
    this.store.run(
      `UPDATE memory_review_runs AS r SET summary='Details cleared because referenced memories were forgotten.',activity_json='[]'
      WHERE workspace_id=? AND EXISTS (
        SELECT 1 FROM json_each(r.activity_json) a,
        json_each(CASE WHEN json_valid(json_extract(a.value,'$.summary')) THEN json_extract(a.value,'$.summary') ELSE '{}' END,'$.facts') f
        WHERE NOT EXISTS(SELECT 1 FROM memory_facts WHERE id=json_extract(f.value,'$.id'))
      )`,
      workspaceId,
    );
    this.store.run(
      "DELETE FROM memory_review_runs WHERE workspace_id=? AND episode_id IN (SELECT id FROM memory_episodes WHERE status='forgotten')",
      workspaceId,
    );
    return this.store
      .all(
        'SELECT * FROM memory_review_runs WHERE workspace_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100',
        workspaceId,
      )
      .map((row) => ({
        id: String(row.id),
        conversationId: String(row.conversation_id),
        conversationName: String(row.conversation_name),
        kind: String(row.kind),
        ownerId: row.owner_id as string | null,
        status: row.status as MemoryReviewRun['status'],
        startedAt: String(row.started_at),
        finishedAt: row.finished_at as string | null,
        summary: String(row.summary),
        error: row.error as string | null,
        episodeId: String(row.episode_id),
        messageIds: JSON.parse(String(row.message_ids)),
        activity: JSON.parse(String(row.activity_json)),
      }));
  }
  describe(episodeId: string, summary: string) {
    this.store.run(
      "UPDATE memory_review_runs SET summary=? WHERE episode_id=? AND status='running'",
      redactCredentials(summary).slice(0, 4000),
      episodeId,
    );
  }
  retry(workspaceId: string, id: string) {
    const row = this.store.get(
      "SELECT * FROM memory_review_runs WHERE workspace_id=? AND id=? AND status='failed'",
      workspaceId,
      id,
    );
    if (!row) throw new ApiError(404, 'Failed memory review not found.');
    this.store.run(
      'UPDATE memory_review_jobs SET blocked=0,due_at=? WHERE conversation_id=?',
      Date.now(),
      String(row.conversation_id),
    );
  }
  drain(signal: AbortSignal): Promise<string[]> {
    if (this.processing) return this.processing;
    // Set the guard before starting work, including callbacks that may enqueue more.
    const task = Promise.resolve().then(() => this.run(signal));
    this.processing = task;
    void task
      .finally(() => {
        if (this.processing === task) this.processing = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async run(signal: AbortSignal) {
    const updated = new Set<string>();
    const jobs = this.store
      .all(
        `SELECT j.* FROM memory_review_jobs j JOIN bots b ON b.id=j.actor_id AND b.workspace_id=j.workspace_id
       WHERE j.due_at<=? AND j.blocked=0
       AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=j.conversation_id AND sequence>j.checkpoint)
       AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=j.conversation_id AND status='streaming')
       ORDER BY j.due_at,j.rowid`,
        Date.now(),
      )
      .filter((job) => this.enabled(String(job.workspace_id)))
      .slice(0, 8);
    for (const queued of jobs) {
      signal.throwIfAborted();
      // Another conversation may have resumed while an earlier review was running.
      const job = this.store.get(
        'SELECT * FROM memory_review_jobs WHERE conversation_id=? AND due_at<=? AND blocked=0',
        String(queued.conversation_id),
        Date.now(),
      );
      if (!job) continue;
      const w = String(job.workspace_id),
        c = String(job.conversation_id);
      if (
        !this.enabled(w) ||
        this.store.get(
          "SELECT id FROM messages WHERE conversation_id=? AND status='streaming' LIMIT 1",
          c,
        )
      )
        continue;
      const conversation = this.store.get(
        'SELECT * FROM conversations WHERE id=? AND workspace_id=?',
        c,
        w,
      );
      const bot = this.bots.find(String(job.actor_id));
      if (!conversation || !bot || bot.workspaceId !== w) continue;
      const pending = this.store.all(
        'SELECT * FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 40',
        c,
        Number(job.checkpoint),
      );
      if (!pending.length) continue;
      const selected: typeof pending = [],
        transcript: unknown[] = [];
      let size = 0;
      for (const row of pending) {
        const entry = {
          role: row.role,
          botId: row.bot_id,
          origin:
            conversation.kind === 'pursuit_run' && row.role === 'user'
              ? 'scheduled instructions, not a human statement'
              : 'conversation',
          status: row.status,
          timestamp: row.created_at,
          content: redactCredentials(String(row.content)).slice(0, 8000),
          evidence: JSON.parse(String(row.activity_json || '[]'))
            .slice(0, 12)
            .map((activity: { tool: string; action: string; status: string; summary: string }) => ({
              tool: activity.tool,
              action: activity.action,
              status: activity.status,
              result: redactCredentials(activity.summary || '').slice(0, 700),
            })),
        };
        let length = JSON.stringify(entry).length;
        while (length > 18000) {
          entry.content = entry.content.slice(0, Math.floor(entry.content.length / 2));
          entry.evidence = entry.evidence.slice(0, Math.floor(entry.evidence.length / 2));
          length = JSON.stringify(entry).length;
        }
        if (selected.length && size + length > 21000) break;
        selected.push(row);
        transcript.push(entry);
        size += length;
      }
      const last = selected.at(-1)!;
      const owner = conversation.kind === 'private' ? bot.id : null;
      const episode = this.engine.enqueue({
        workspaceId: w,
        ownerId: owner,
        actorId: bot.id,
        sourceKey: `review:${c}:${job.checkpoint}:${last.sequence}`,
        sourceType: 'user',
        content: JSON.stringify({
          messages: transcript,
          note: 'Long messages and evidence may be truncated. Save only supported facts; do not infer omitted content.',
        }),
        referenceTime: String(last.created_at),
        conversationId: c,
        messageId: String(last.id),
        context: this.store
          .all(
            'SELECT role,content FROM messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 4',
            c,
            Number(job.checkpoint),
          )
          .reverse()
          .map((row) => `${row.role}: ${row.content}`)
          .join('\n')
          .slice(-6000),
      });
      const id = randomUUID(),
        started = new Date().toISOString();
      const activity = [
        {
          id: randomUUID(),
          tool: 'memory_review',
          action: 'review',
          path: `${selected.length} messages`,
          status: 'running',
          summary: 'Reviewing conversation evidence and related memories.',
        },
      ];
      this.store.run(
        `INSERT INTO memory_review_runs(id,workspace_id,conversation_id,conversation_name,kind,owner_id,status,started_at,summary,episode_id,message_ids,activity_json)
        VALUES(?,?,?,?,?,?,'running',?,'',?,?,?)`,
        id,
        w,
        c,
        String(conversation.name),
        String(conversation.kind),
        owner,
        started,
        episode.id,
        JSON.stringify(selected.map((row) => row.id)),
        JSON.stringify(activity),
      );
      try {
        const searchStarted = new Date().toISOString();
        const searchScope = { workspaceId: w, privateOwner: owner || undefined };
        const searchQuery =
          selected
            .filter((row) => row.role === 'user')
            .map((row) => String(row.content).slice(0, 500))
            .join(' ')
            .slice(0, 2000) || 'conversation findings';
        const hits = this.search
          ? await this.search(searchScope, searchQuery)
          : await this.engine.searchMemory(searchScope, searchQuery, { limit: 12 });
        activity.push({
          id: randomUUID(),
          tool: 'memory',
          action: 'search',
          path: owner ? 'Private' : 'Workspace',
          status: 'complete',
          summary: JSON.stringify({
            startedAt: searchStarted,
            facts: hits.map((hit) => ({ id: hit.fact.id, text: hit.fact.text })),
          }),
        });
        this.store.run(
          'UPDATE memory_review_runs SET activity_json=? WHERE id=?',
          JSON.stringify(activity),
          id,
        );
        await this.engine.processEpisode(episode.id, signal);
        const facts = this.engine.episodeFacts(
          { workspaceId: w, privateOwner: owner || undefined },
          episode.id,
        );
        activity[0].status = 'complete';
        activity[0].summary = `${facts.length} supported facts retained. Existing facts are deduplicated and reconciled by the memory engine.`;
        if (facts.length)
          activity.push({
            id: randomUUID(),
            tool: 'memory',
            action: 'add',
            path: owner ? 'Private' : 'Workspace',
            status: 'complete',
            summary: JSON.stringify({
              facts: facts.map((fact) => ({
                id: fact.id,
                text: fact.text,
                supersededBy: fact.supersededBy,
              })),
            }),
          });
        this.store.run(
          "UPDATE memory_review_runs SET status='complete',finished_at=?,summary=CASE WHEN summary='' THEN ? ELSE summary END,activity_json=? WHERE id=?",
          new Date().toISOString(),
          facts.length
            ? `Retained ${facts.length} facts from this exchange.`
            : 'No durable information needed saving.',
          JSON.stringify(activity),
          id,
        );
        this.store.run(
          'UPDATE memory_review_jobs SET checkpoint=MAX(checkpoint,?) WHERE conversation_id=?',
          Number(last.sequence),
          c,
        );
        updated.add(w);
      } catch {
        activity[0].status = 'failed';
        activity[0].summary = 'Review failed. No checkpoint was advanced.';
        this.store.run(
          "UPDATE memory_review_runs SET status='failed',finished_at=?,error=?,activity_json=? WHERE id=?",
          new Date().toISOString(),
          signal.aborted
            ? 'Review interrupted when Mukai stopped.'
            : 'Memory review failed. Check the configured model and retry.',
          JSON.stringify(activity),
          id,
        );
        this.store.run('UPDATE memory_review_jobs SET blocked=1 WHERE conversation_id=?', c);
      }
    }
    return [...updated];
  }
}
