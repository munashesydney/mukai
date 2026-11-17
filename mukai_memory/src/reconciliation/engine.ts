import { createHash, randomUUID } from 'node:crypto';
import { extractionSchema } from '../extraction/schema';
import { redactCredentials } from '../extraction/redact';
import { normalize, SQLiteMemoryStore } from '../storage/sqlite';
import type {
  ConsolidatedClaim,
  ConsolidationReport,
  Embedder,
  EpisodeInput,
  ExtractedFact,
  Extractor,
  MemoryFact,
  MemoryGraph,
  MemoryScope,
  SearchHit,
  SearchOptions,
} from '../types';

export const normalizeMemoryDate = (value: string) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid memory date.');
  return parsed.toISOString();
};
const date = normalizeMemoryDate;
/**
 * Dates a model invents when a statement has no stated beginning: the Unix epoch day itself, or a
 * year-zero placeholder. Genuine historical dates carry a month and day, so they are left alone.
 */
const placeholderDate = (value: string) =>
  value < '1000-01-01T00:00:00.000Z' ||
  (value >= '1970-01-01T00:00:00.000Z' && value < '1970-01-02T00:00:00.000Z');
/**
 * Capture usually fails because the model is busy, restarting, or out of memory — conditions that
 * pass. Retry on a bounded backoff instead of discarding the exchange at the first error; once the
 * attempts run out the source stays visible as failed so the user can retry it deliberately.
 */
export const CAPTURE_RETRY_DELAYS = [60000, 300000, 1800000] as const;
export const CAPTURE_ATTEMPT_LIMIT = CAPTURE_RETRY_DELAYS.length + 1;
/** When an episode that just failed may run again, or null once the bounded retries are spent. */
export const captureRetryAt = (attempts: number, now = Date.now()) =>
  attempts >= CAPTURE_ATTEMPT_LIMIT
    ? null
    : now + CAPTURE_RETRY_DELAYS[Math.min(Math.max(attempts, 1), CAPTURE_RETRY_DELAYS.length) - 1];
const activeAt = (fact: MemoryFact, at: string) =>
  fact.validFrom <= at && (!fact.validTo || fact.validTo > at);

export class MemoryEpisodeInvalidatedError extends Error {
  constructor() {
    super('A message used by this review was forgotten.');
  }
}
const tokens = (text: string) =>
  [...new Set(normalize(text).match(/[\p{L}\p{N}_-]{2,}/gu) || [])].filter(
    (word) =>
      ![
        'the',
        'and',
        'for',
        'with',
        'what',
        'that',
        'this',
        'was',
        'are',
        'you',
        'does',
        'about',
        'have',
        'from',
        'can',
        'our',
        'how',
      ].includes(word),
  );

export class MemoryEngine {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: SQLiteMemoryStore,
    private extractor: Extractor,
    readonly embedder?: Embedder,
  ) {}

  enqueue(input: EpisodeInput) {
    const content = redactCredentials(input.content.trim());
    if (!content || content.length > 24000)
      throw new Error('Memory content must be between 1 and 24000 characters.');
    if (!input.workspaceId || !input.sourceKey || input.sourceKey.length > 300)
      throw new Error('A workspace and source key are required.');
    const existing = this.store.get(
      'SELECT * FROM memory_episodes WHERE workspace_id=? AND source_key=?',
      input.workspaceId,
      input.sourceKey,
    );
    if (existing) return this.store.episode(existing);
    const id = randomUUID();
    this.store.run(
      'INSERT INTO memory_episodes(id,workspace_id,owner_id,actor_id,source_key,source_type,content,reference_time,conversation_id,message_id,context,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.workspaceId,
      input.ownerId || null,
      input.actorId || null,
      input.sourceKey,
      input.sourceType,
      content,
      date(input.referenceTime),
      input.conversationId || null,
      input.messageId || null,
      redactCredentials(input.context || '').slice(-6000),
      new Date().toISOString(),
      'pending',
    );
    return this.store.episode(this.store.get('SELECT * FROM memory_episodes WHERE id=?', id)!);
  }
  async addMemory(input: EpisodeInput, signal?: AbortSignal) {
    const episode = this.enqueue(input);
    await this.processEpisode(episode.id, signal);
    return this.episodeFacts(
      { workspaceId: input.workspaceId, privateOwner: input.ownerId || undefined },
      episode.id,
    );
  }
  processEpisode(id: string, signal?: AbortSignal): Promise<void> {
    const row = this.store.get('SELECT * FROM memory_episodes WHERE id=?', id);
    if (!row) return Promise.reject(new Error('Memory episode not found.'));
    const key = `${row.workspace_id}:${row.owner_id || ''}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.process(id, signal));
    this.queues.set(key, next);
    void next
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async process(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row = this.store.get('SELECT * FROM memory_episodes WHERE id=?', id);
    if (!row || ['complete', 'forgotten'].includes(String(row.status))) return;
    const episode = this.store.episode(row);
    this.store.run(
      "UPDATE memory_episodes SET status='processing',attempts=attempts+1,error=NULL,retry_at=NULL WHERE id=?",
      id,
    );
    try {
      if (this.store.hasForgottenInputs(id)) throw new MemoryEpisodeInvalidatedError();
      const candidates = this.store
        .facts({ workspaceId: episode.workspaceId, privateOwner: episode.ownerId || undefined })
        .filter((fact) => fact.ownerId === (episode.ownerId || null));
      const words = tokens(episode.content);
      const related = candidates
        .map((fact) => ({
          fact,
          score: words.filter((word) =>
            normalize(`${fact.subject} ${fact.object} ${fact.text}`).includes(word),
          ).length,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map(({ fact }) => fact);
      const extracted = await this.extractor({ episode, candidates: related, signal });
      // Older host adapters can omit references; native structured output requires
      // all schema fields and expresses new entities with explicit null IDs.
      const result = extractionSchema.parse({
        ...extracted,
        facts: extracted.facts.map((fact) => ({ subjectId: null, objectId: null, ...fact })),
      });
      signal?.throwIfAborted();
      this.store.transaction(() => {
        if (
          this.store.get('SELECT status FROM memory_episodes WHERE id=?', id)?.status !==
          'processing'
        )
          return;
        if (this.store.hasForgottenInputs(id)) throw new MemoryEpisodeInvalidatedError();
        for (const fact of result.facts)
          this.commit(
            episode.workspaceId,
            episode.ownerId || null,
            id,
            fact,
            episode.referenceTime,
            related,
          );
        this.store.run("UPDATE memory_episodes SET status='complete',error=NULL WHERE id=?", id);
        if (!result.facts.length)
          this.store.run("UPDATE memory_episodes SET content='',context='' WHERE id=?", id);
      });
    } catch (error) {
      if (error instanceof MemoryEpisodeInvalidatedError) {
        this.store.run(
          "UPDATE memory_episodes SET status='complete',content='',context='',error=NULL,retry_at=NULL WHERE id=? AND status='processing'",
          id,
        );
        throw error;
      }
      const attempts = Number(
        this.store.get('SELECT attempts FROM memory_episodes WHERE id=?', id)?.attempts ?? 1,
      );
      // An abort is not a failure and goes straight back to the queue. A real error waits for its
      // next scheduled attempt; once the bounded retries are spent it stays failed for the user.
      this.store.run(
        "UPDATE memory_episodes SET status=?,error=?,retry_at=? WHERE id=? AND status='processing'",
        signal?.aborted ? 'pending' : 'failed',
        signal?.aborted ? null : 'Memory extraction failed. Check the configured model and retry.',
        signal?.aborted ? null : captureRetryAt(attempts),
        id,
      );
      throw error;
    }
  }
  private entity(
    workspaceId: string,
    ownerId: string | null,
    name: string,
    type: string,
    aliases: string[],
    reference?: string | null,
    candidates: MemoryFact[] = [],
  ) {
    const owner = ownerId || '';
    if (reference) {
      if (
        !candidates.some(
          (fact) =>
            fact.workspaceId === workspaceId &&
            fact.ownerId === ownerId &&
            [fact.subjectId, fact.objectId].includes(reference),
        )
      )
        throw new Error('Entity reference is not an authorized extraction candidate.');
      const entity = this.store.get(
        'SELECT id FROM memory_entities WHERE id=? AND workspace_id=? AND owner_key=?',
        reference,
        workspaceId,
        owner,
      );
      if (!entity) throw new Error('Referenced memory entity is no longer available.');
      return reference;
    }
    const normalized = normalize(name);
    // Never merge via a guessed alias. A canonical name may match an existing alias.
    const existing =
      this.store.get(
        'SELECT id FROM memory_entities WHERE workspace_id=? AND owner_key=? AND normalized_name=?',
        workspaceId,
        owner,
        normalized,
      ) ||
      this.store.get(
        'SELECT entity_id AS id FROM memory_aliases WHERE workspace_id=? AND owner_key=? AND alias=?',
        workspaceId,
        owner,
        normalized,
      );
    const id = existing ? String(existing.id) : randomUUID();
    if (!existing)
      this.store.run(
        'INSERT INTO memory_entities VALUES(?,?,?,?,?,?)',
        id,
        workspaceId,
        owner,
        name.trim(),
        normalized,
        type,
      );
    for (const alias of aliases) {
      const canonical = this.store.get(
        'SELECT id FROM memory_entities WHERE workspace_id=? AND owner_key=? AND normalized_name=?',
        workspaceId,
        owner,
        normalize(alias),
      );
      if (!canonical || canonical.id === id)
        this.store.run(
          'INSERT OR IGNORE INTO memory_aliases VALUES(?,?,?,?)',
          workspaceId,
          owner,
          normalize(alias),
          id,
        );
    }
    return id;
  }
  private commit(
    workspaceId: string,
    ownerId: string | null,
    episodeId: string,
    fact: ExtractedFact,
    referenceTime: string,
    candidates: MemoryFact[],
    explicitCorrection = false,
    // Imports are a restore: their intervals are the record, not a model guess to repair.
    trustedIntervals = false,
  ) {
    let from = date(fact.validFrom || referenceTime);
    // Models emit epoch zero when a statement has no stated beginning; that is not a 1970 claim.
    if (!trustedIntervals && placeholderDate(from)) from = date(referenceTime);
    let to = fact.validTo ? date(fact.validTo) : null;
    if (!trustedIntervals && to && placeholderDate(to)) to = null;
    // An end equal to its start is a retraction, which is how corrections keep their audit trail.
    if (to && to < from) throw new Error('A memory end must follow its start.');
    const subjectId = this.entity(
      workspaceId,
      ownerId,
      fact.subject,
      fact.subjectType,
      fact.subjectAliases,
      fact.subjectId,
      candidates,
    );
    const objectId = this.entity(
      workspaceId,
      ownerId,
      fact.object,
      fact.objectType,
      fact.objectAliases,
      fact.objectId,
      candidates,
    );
    const relation = normalize(fact.relation)
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_|_$/g, '');
    if (!relation) throw new Error('A relationship is required.');
    const siblings = this.store.all(
      'SELECT * FROM memory_facts WHERE workspace_id=? AND owner_id IS ? AND subject_id=? AND relation=? AND object_id=?',
      workspaceId,
      ownerId,
      subjectId,
      relation,
      objectId,
    );
    const replaces = fact.disposition === 'replace' || fact.disposition === 'correct';
    const state = fact.disposition === 'uncertain' ? 'uncertain' : 'confirmed';
    // One claim, possibly re-learned: identical wording whose spans overlap. The test used to demand
    // the stored row start no earlier than the new one, so the same sentence learned twice within
    // minutes - once from a tool finding, once from the review of that message - was written twice.
    const sameClaim = (row: Record<string, string | number | null>) =>
      normalize(String(row.text)) === normalize(fact.text) &&
      (row.valid_to || null) === to &&
      (!row.valid_to || String(row.valid_to) > from) &&
      (!to || String(row.valid_from) < to);
    const duplicate = siblings.find((row) => sameClaim(row) && row.state === state);
    // The same sentence stored once hedged and once confirmed used to be served twice, once each way.
    const hedged = siblings.find((row) => sameClaim(row) && row.state !== state);
    if (duplicate && !replaces) return this.mergeFact(duplicate, episodeId, from, false);
    if (hedged && !replaces) return this.mergeFact(hedged, episodeId, from, state === 'confirmed');
    const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const targets = replaces
      ? fact.supersedes
          .map((id) => allowed.get(id) || this.storedFact(workspaceId, id))
          .filter((target): target is MemoryFact =>
            Boolean(
              target &&
              target.workspaceId === workspaceId &&
              target.ownerId === ownerId &&
              target.subjectId === subjectId &&
              target.relation === relation &&
              (explicitCorrection || target.state === 'confirmed') &&
              !target.supersededBy,
            ),
          )
          .filter((target) => {
            const current = this.store.get(
              'SELECT valid_to,superseded_by,state FROM memory_facts WHERE id=?',
              target.id,
            );
            return (
              current &&
              current.valid_to === target.validTo &&
              current.superseded_by === target.supersededBy &&
              current.state === target.state
            );
          })
      : [];
    // A correction that could not resolve a target is a hedge, not a replacement, and must not leave
    // a second copy of the claim it meant to replace.
    if (replaces && !targets.length && (duplicate || hedged))
      return this.mergeFact(duplicate || hedged!, episodeId, from, false);
    const currentState =
      fact.disposition === 'uncertain' || (replaces && !targets.length) ? 'uncertain' : 'confirmed';
    let supersededBy: string | null = null;
    for (const target of targets) {
      if (
        fact.disposition !== 'correct' &&
        target.validFrom > from &&
        (!to || target.validFrom < to)
      ) {
        to = target.validFrom;
        supersededBy = target.id;
      }
    }
    const id = randomUUID();
    this.store.run(
      'INSERT INTO memory_facts(id,workspace_id,owner_id,subject_id,relation,object_id,text,valid_from,valid_to,created_at,superseded_by,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      workspaceId,
      ownerId,
      subjectId,
      relation,
      objectId,
      fact.text.trim(),
      from,
      to,
      new Date().toISOString(),
      supersededBy,
      currentState,
    );
    this.store.run('INSERT INTO memory_fact_sources VALUES(?,?)', id, episodeId);
    this.store.run(
      'INSERT INTO memory_fts(fact_id,text) VALUES(?,?)',
      id,
      `${fact.subject} ${relation} ${fact.object} ${fact.text}`,
    );
    for (const target of targets) {
      if (fact.disposition === 'correct') {
        this.store.run(
          'UPDATE memory_facts SET valid_to=valid_from,superseded_by=? WHERE id=?',
          id,
          target.id,
        );
        continue;
      }
      if (
        target.validFrom < from &&
        (!target.validTo || target.validTo > from) &&
        (!to || to > from)
      )
        this.store.run(
          'UPDATE memory_facts SET valid_to=?,superseded_by=? WHERE id=?',
          from,
          id,
          target.id,
        );
      // Corrections at the exact same effective timestamp still replace the recorded belief.
      if (target.validFrom === from)
        this.store.run(
          'UPDATE memory_facts SET valid_to=?,superseded_by=? WHERE id=?',
          from,
          id,
          target.id,
        );
    }
    return id;
  }
  /**
   * The engine met a claim it already holds. Keep one row: attach the new provenance, take the
   * earlier start, and let a plain statement settle a hedged copy of the same sentence. A confirmed
   * record is never weakened, and an interval that has already ended keeps its end - history is not
   * a duplicate.
   */
  private mergeFact(
    existing: Record<string, string | number | null>,
    episodeId: string,
    from: string,
    strengthen: boolean,
  ) {
    const id = String(existing.id);
    this.store.run('INSERT OR IGNORE INTO memory_fact_sources VALUES(?,?)', id, episodeId);
    if (strengthen && existing.state !== 'confirmed')
      this.store.run("UPDATE memory_facts SET state='confirmed' WHERE id=?", id);
    if (from < String(existing.valid_from))
      this.store.run('UPDATE memory_facts SET valid_from=? WHERE id=?', from, id);
    return id;
  }
  /**
   * A correction may name a fact it saw in the recall trace rather than in the candidate window
   * handed to the extractor, so those ids are looked up instead of silently dropped - otherwise the
   * "correction" is stored as a second copy of the claim it meant to replace.
   */
  private storedFact(workspaceId: string, id: string) {
    if (!id) return undefined;
    const row = this.store.get(
      `SELECT f.*,s.name AS subject,o.name AS object FROM memory_facts f
       JOIN memory_entities s ON s.id=f.subject_id JOIN memory_entities o ON o.id=f.object_id
       WHERE f.id=? AND f.workspace_id=?`,
      id,
      workspaceId,
    );
    // Provenance is irrelevant for a supersede target, so skip loading it.
    return row ? this.store.fact(row, []) : undefined;
  }
  episodeFacts(scope: MemoryScope, episodeId: string) {
    return this.store
      .facts(scope)
      .filter((fact) => fact.sources.some((source) => source.id === episodeId));
  }
  /**
   * Claims written before the write path compared overlapping intervals are served twice in some
   * workspaces: one sentence, same subject, relationship and object, both open-ended. This folds each
   * of those into a single row - earliest start, every source, the stronger of hedge and plain - and
   * reattaches lineage that pointed at a folded copy. Nothing else moves: a row with an end date is
   * another era rather than a duplicate, so history is never rewritten. Dry run unless asked to
   * apply, because this is the one memory operation that removes rows.
   */
  consolidateClaims(scope: MemoryScope, apply = false, limit = 100): ConsolidationReport {
    const where = this.store.scope(scope, 'f');
    const groups = new Map<string, Record<string, string | number | null>[]>();
    for (const row of this.store.all(
      `SELECT f.id,f.owner_id,f.subject_id,f.relation,f.object_id,f.text,f.valid_from,f.created_at,f.state
       FROM memory_facts f
       WHERE ${where.sql} AND f.valid_to IS NULL AND f.superseded_by IS NULL
       ORDER BY f.valid_from,f.created_at,f.id`,
      ...where.params,
    )) {
      const key = [
        row.owner_id,
        row.subject_id,
        row.relation,
        row.object_id,
        normalize(String(row.text)),
      ].join('\u0000');
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    const claims: ConsolidatedClaim[] = [];
    let removed = 0;
    let sourcesMoved = 0;
    this.store.transaction(() => {
      for (const rows of groups.values()) {
        if (rows.length < 2 || claims.length >= Math.max(1, limit)) continue;
        // Keep the row that already says the most, started earliest, and has been known longest. Every
        // source ends up on it either way, so its id is the only real choice being made.
        const [kept, ...folded] = [...rows].sort(
          (a, b) =>
            Number(b.state === 'confirmed') - Number(a.state === 'confirmed') ||
            String(a.valid_from).localeCompare(String(b.valid_from)) ||
            String(a.created_at).localeCompare(String(b.created_at)) ||
            String(a.id).localeCompare(String(b.id)),
        );
        const survivor = String(kept.id);
        const episodes = new Set(
          this.store
            .all('SELECT episode_id FROM memory_fact_sources WHERE fact_id=?', survivor)
            .map((row) => String(row.episode_id)),
        );
        let moved = 0;
        for (const row of folded) {
          const sources = this.store
            .all('SELECT episode_id FROM memory_fact_sources WHERE fact_id=?', String(row.id))
            .map((source) => String(source.episode_id));
          moved += sources.filter((episode) => !episodes.has(episode)).length;
          for (const episode of sources) episodes.add(episode);
          if (!apply) continue;
          this.store.run(
            'INSERT OR IGNORE INTO memory_fact_sources SELECT ?,episode_id FROM memory_fact_sources WHERE fact_id=?',
            survivor,
            String(row.id),
          );
          // Lineage stays meaningful: the claim that replaced a folded copy replaced the same claim.
          this.store.run(
            'UPDATE memory_facts SET superseded_by=? WHERE superseded_by=?',
            survivor,
            String(row.id),
          );
          this.store.run('DELETE FROM memory_fts WHERE fact_id=?', String(row.id));
          this.store.run('DELETE FROM memory_facts WHERE id=?', String(row.id));
        }
        const from = rows.map((row) => String(row.valid_from)).sort()[0];
        const state = rows.some((row) => row.state === 'confirmed') ? 'confirmed' : 'uncertain';
        if (apply && (from !== String(kept.valid_from) || state !== String(kept.state)))
          this.store.run(
            'UPDATE memory_facts SET valid_from=?,state=? WHERE id=?',
            from,
            state,
            survivor,
          );
        claims.push({
          kept: survivor,
          removed: folded.map((row) => String(row.id)),
          text: String(kept.text),
          sourcesMoved: moved,
        });
        removed += folded.length;
        sourcesMoved += moved;
      }
    });
    return { applied: apply, groups: claims.length, removed, sourcesMoved, claims };
  }
  async indexEmbeddings(scope: MemoryScope, signal?: AbortSignal, limit?: number) {
    if (!this.embedder) return 0;
    const rows = this.store
      .pendingVectors(scope, this.embedder.model)
      .slice(0, Math.max(0, limit ?? Number.MAX_SAFE_INTEGER));
    let count = 0;
    for (let start = 0; start < rows.length; start += 16) {
      signal?.throwIfAborted();
      const batch = rows.slice(start, start + 16);
      const vectors = await this.embedder.embed(
        batch.map((row) => String(row.text)),
        'document',
      );
      signal?.throwIfAborted();
      if (vectors.length !== batch.length) throw new Error('Embedding batch size mismatch.');
      batch.forEach((row, index) => {
        if (!vectors[index].length || vectors[index].some((value) => !Number.isFinite(value)))
          throw new Error('Invalid embedding.');
        this.store.run(
          'UPDATE memory_facts SET vector_json=?,vector_model=? WHERE id=?',
          JSON.stringify(vectors[index]),
          this.embedder!.model,
          String(row.id),
        );
        this.store.forgetVector(String(row.id));
        count++;
      });
    }
    return count;
  }
  /** Cheap check for rows the active embedding model has not covered yet. */
  pendingEmbeddings(scope: MemoryScope) {
    if (!this.embedder) return 0;
    const where = this.store.scope(scope);
    const row = this.store.get(
      `SELECT COUNT(*) AS count FROM memory_facts f WHERE ${where.sql}
       AND (vector_json IS NULL OR vector_model IS NULL OR vector_model<>?)`,
      ...where.params,
      this.embedder.model,
    );
    return Number(row?.count || 0);
  }
  async searchMemory(
    scope: MemoryScope,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(100, options.limit || 12));
    const at = date(options.asOf || new Date().toISOString());
    const where = this.store.scope(scope);
    if (options.asOf || !options.includeHistory) {
      where.sql += ' AND f.valid_from<=? AND (f.valid_to IS NULL OR f.valid_to>?)';
      where.params.push(at, at);
    }
    const rows = this.store.factRows(where);
    // Uncertain records sit in a second tier: they stay out of normal recall, but a workspace whose
    // only record of something is uncertain must still answer, hedged, instead of answering nothing.
    const uncertain = options.includeUncertain
      ? []
      : rows.filter((row) => row.state !== 'confirmed');
    const tiers = uncertain.length
      ? [rows.filter((row) => row.state === 'confirmed'), uncertain]
      : [rows];
    const words = tokens(query).slice(0, 40);
    // A bare number matches unrelated counters — “31 August” recalling “number 31” — so numeric terms
    // only widen the keyword match when the query carries no words.
    const lexical = words.filter((word) => !/^\p{N}+$/u.test(word));
    const terms = lexical.length ? lexical : words;
    let embedded: Promise<{ vector: number[]; norm: number } | null> | undefined;
    const embedQuery = () =>
      (embedded ??= (async () => {
        if (!this.embedder) return null;
        try {
          const [vector] = await this.embedder.embed([query.slice(0, 2000)], 'query');
          if (!vector || !vector.length) return null;
          return { vector, norm: Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) };
        } catch {
          return null;
        }
      })());
    // Vector payloads are read once per query for the whole scope, and reused across queries:
    // a 384-float vector per fact is far more data than the facts themselves.
    const vectors =
      this.embedder && query.trim()
        ? this.store.vectorsIn(scope, this.embedder.model)
        : new Map<string, { model: string; values: number[]; norm: number }>();
    for (const tier of tiers) {
      const ranks = terms.length
        ? this.keywordRanks(
            where,
            terms,
            tiers.length === 1 ? null : tier === uncertain ? 'uncertain' : 'confirmed',
          )
        : new Map<string, number>();
      const results = new Map<
        string,
        Pick<SearchHit, 'score' | 'reasons'> & { row: (typeof rows)[number] }
      >();
      const add = (row: Record<string, string | number | null>, score: number, reason: string) => {
        const id = String(row.id);
        const hit = results.get(id);
        if (hit) {
          hit.score += score;
          hit.reasons.push(reason);
        } else results.set(id, { row, score, reasons: [reason] });
      };
      for (const row of tier) {
        const position = ranks.get(String(row.id));
        if (position !== undefined) add(row, 1 / (30 + position), 'keyword');
        if (
          words.some((word) =>
            [normalize(String(row.subject)), normalize(String(row.object))].includes(word),
          )
        )
          add(row, 0.025, 'entity');
      }
      if (this.embedder && query.trim() && vectors.size) {
        const question = await embedQuery();
        if (question && question.norm) {
          const semantic = tier
            .map((row) => ({ row, stored: vectors.get(String(row.id)) }))
            .filter((item) => item.stored)
            .map(({ row, stored }) => {
              const values = stored!.values;
              const denominator = stored!.norm * question.norm;
              return {
                row,
                similarity:
                  denominator && values.length === question.vector.length
                    ? values.reduce(
                        (sum, value, index) => sum + value * question.vector[index],
                        0,
                      ) / denominator
                    : 0,
              };
            })
            .filter((item) => item.similarity >= 0.65)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 60);
          semantic.forEach(({ row }, index) => add(row, 1 / (30 + index), 'semantic'));
        }
      }
      const seeds = [...results.values()].sort((a, b) => b.score - a.score).slice(0, 4);
      const entities = new Set(
        seeds.flatMap(({ row }) => [String(row.subject_id), String(row.object_id)]),
      );
      // A single bounded hop avoids unrelated graph neighborhoods overwhelming recall.
      for (const row of tier
        .filter(
          (row) => entities.has(String(row.subject_id)) || entities.has(String(row.object_id)),
        )
        .slice(0, 24))
        if (!results.has(String(row.id))) add(row, 0.006, 'related entity');
      if (!query.trim()) tier.slice(0, limit).forEach((row) => add(row, 0.001, 'recent'));
      if (results.size) {
        // Embedding awaits the worker. Facts removed or changed during that wait must not
        // be emitted from the earlier keyword or vector snapshot.
        const ranked = [...results.values()].sort(
          (a, b) =>
            b.score - a.score || String(b.row.created_at).localeCompare(String(a.row.created_at)),
        );
        const current: typeof ranked = [];
        for (const hit of ranked) {
          const row = embedded
            ? this.store.factRows({
                sql: `${where.sql} AND f.id=? AND f.state=?`,
                params: [...where.params, hit.row.id, hit.row.state],
              })[0]
            : hit.row;
          if (row) current.push({ ...hit, row });
          if (current.length >= limit) break;
        }
        const hits = this.store.hydrateFacts(current.map(({ row }) => row));
        if (hits.length)
          return hits.map((fact, index) => ({
            fact,
            score: current[index].score,
            reasons: current[index].reasons,
          }));
      }
    }
    return [];
  }
  private keywordRanks(
    where: ReturnType<SQLiteMemoryStore['scope']>,
    words: string[],
    state: 'confirmed' | 'uncertain' | null,
  ) {
    // FTS terms are quoted, never interpolated into SQL or parsed as operators.
    const matches = this.store.all(
      `SELECT memory_fts.fact_id,bm25(memory_fts) AS rank FROM memory_fts JOIN memory_facts f ON f.id=memory_fts.fact_id WHERE memory_fts MATCH ? AND ${where.sql}${state ? ' AND f.state=?' : ''} ORDER BY rank,f.id LIMIT 300`,
      words.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR '),
      ...where.params,
      ...(state ? [state] : []),
    );
    return new Map<string, number>(matches.map((row, index) => [String(row.fact_id), index]));
  }
  async getContext(scope: MemoryScope, query: string, maxBytes = 5000) {
    const hits = await this.searchMemory(scope, query, { limit: 12 });
    const selected: SearchHit[] = [];
    let content = '';
    for (const hit of hits) {
      const line =
        JSON.stringify({
          id: hit.fact.id,
          fact: hit.fact.text,
          validFrom: hit.fact.validFrom,
          validTo: hit.fact.validTo,
          // Uncertain records and assistant-authored ones are leads to verify, not established truth.
          state: hit.fact.state,
          evidence: [...new Set(hit.fact.sources.map((source) => source.sourceType))],
          sourceIds: hit.fact.sources.map((source) => source.id),
        }) + '\n';
      if (Buffer.byteLength(content + line, 'utf8') > maxBytes) continue;
      content += line;
      selected.push(hit);
    }
    return { content, hits: selected };
  }
  getGraph(
    scope: MemoryScope,
    options: { focus?: string; includeHistory?: boolean; limit?: number; asOf?: string } = {},
  ): MemoryGraph {
    const at = options.asOf ? date(options.asOf) : new Date().toISOString();
    let edges = this.store
      .facts(scope)
      .filter((fact) =>
        options.asOf ? activeAt(fact, at) : options.includeHistory || activeAt(fact, at),
      );
    if (options.focus)
      edges = edges.filter(
        (fact) => fact.subjectId === options.focus || fact.objectId === options.focus,
      );
    const limit = Math.max(1, Math.min(300, options.limit || 100));
    const truncated = edges.length > limit;
    edges = edges.slice(0, limit);
    return this.graphFromFacts(scope, edges, truncated);
  }

  graphFromFacts(scope: MemoryScope, edges: MemoryFact[], truncated: boolean): MemoryGraph {
    const ids = [...new Set(edges.flatMap((fact) => [fact.subjectId, fact.objectId]))];
    if (!ids.length) return { nodes: [], edges, truncated };
    const nodes = this.store
      .all(
        `SELECT * FROM memory_entities WHERE workspace_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        scope.workspaceId,
        ...ids,
      )
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        type: String(row.type),
        ownerId: row.owner_key ? String(row.owner_key) : null,
      }));
    return { nodes, edges, truncated };
  }
  correctMemory(
    scope: MemoryScope,
    id: string,
    input: { text: string; object: string; validFrom?: string },
  ) {
    const old = this.store.requireFact(scope, id);
    const parsed = extractionSchema.parse({
      facts: [
        {
          subject: old.subject,
          subjectId: old.subjectId,
          subjectType: 'topic',
          subjectAliases: [],
          relation: old.relation,
          object: input.object,
          objectId: null,
          objectType: 'topic',
          objectAliases: [],
          text: input.text,
          validFrom: input.validFrom || new Date().toISOString(),
          validTo: null,
          disposition: 'correct',
          supersedes: [old.id],
        },
      ],
    }).facts[0];
    return this.store.transaction(() => {
      const episode = this.enqueue({
        workspaceId: old.workspaceId,
        ownerId: old.ownerId,
        sourceKey: `correction:${randomUUID()}`,
        sourceType: 'correction',
        content: input.text,
        referenceTime: parsed.validFrom!,
      });
      const newId = this.commit(
        old.workspaceId,
        old.ownerId,
        episode.id,
        parsed,
        episode.referenceTime,
        [old],
        true,
      );
      this.store.run("UPDATE memory_episodes SET status='complete' WHERE id=?", episode.id);
      return this.store.requireFact(scope, newId);
    });
  }
  importFacts(
    workspaceId: string,
    facts: {
      subject: string;
      relation: string;
      object: string;
      text: string;
      validFrom: string;
      validTo: string | null;
      state: 'confirmed' | 'uncertain';
      ownerId?: string | null;
    }[],
  ) {
    // Reports what actually changed: enqueue() returns the earlier episode for a repeated import,
    // and a forgotten import source is re-armed rather than silently skipped.
    const counts = { imported: 0, deduplicated: 0, revived: 0 };
    return this.store.transaction(() => {
      for (const fact of facts) {
        const parsed = extractionSchema.parse({
          facts: [
            {
              ...fact,
              subjectId: null,
              objectId: null,
              subjectType: 'topic',
              objectType: 'topic',
              subjectAliases: [],
              objectAliases: [],
              disposition: fact.state === 'uncertain' ? 'uncertain' : 'assert',
              supersedes: [],
            },
          ],
        }).facts[0];
        const key = createHash('sha256').update(JSON.stringify(fact)).digest('hex');
        const episode = this.enqueue({
          workspaceId,
          ownerId: fact.ownerId || null,
          sourceKey: `import:${key}`,
          sourceType: 'import',
          content: fact.text,
          referenceTime: fact.validFrom,
        });
        const hasFact =
          episode.status === 'complete' &&
          this.store.get(
            'SELECT 1 FROM memory_fact_sources WHERE episode_id=? LIMIT 1',
            episode.id,
          );
        const revived =
          episode.status === 'forgotten' || (episode.status === 'complete' && !hasFact);
        if (revived) {
          // A forget has to block automatic replay, but it must not veto a deliberate restore:
          // re-arm this same import source so repeating the import still changes nothing.
          this.store.run(
            "UPDATE memory_episodes SET status='pending',error=NULL,content=? WHERE id=?",
            redactCredentials(fact.text),
            episode.id,
          );
        }
        if (hasFact) {
          counts.deduplicated++;
          continue;
        }
        this.commit(
          workspaceId,
          fact.ownerId || null,
          episode.id,
          parsed,
          episode.referenceTime,
          [],
          false,
          true,
        );
        this.store.run("UPDATE memory_episodes SET status='complete' WHERE id=?", episode.id);
        counts[revived ? 'revived' : 'imported']++;
      }
      return counts;
    });
  }
  forgetMemory(scope: MemoryScope, id: string) {
    const fact = this.store.requireFact(scope, id);
    return this.forgetEpisodes(
      scope,
      fact.sources.map((source) => source.id),
    );
  }
  forgetEpisodes(scope: MemoryScope, ids: string[]) {
    const where = this.store.scope(scope, 'e');
    const sources = new Set<string>();
    let forgotten = 0;
    this.store.transaction(() => {
      for (const id of new Set(ids)) {
        if (
          !this.store.get(
            `SELECT id FROM memory_episodes e WHERE ${where.sql} AND id=?`,
            ...where.params,
            id,
          )
        )
          continue;
        forgotten++;
        sources.add(id);
        const overlaps = this.store.all(
          `SELECT DISTINCT related.episode_id FROM memory_episode_messages input
           JOIN memory_episode_messages related ON related.message_id=input.message_id
           JOIN memory_episodes e ON e.id=related.episode_id
           WHERE input.episode_id=? AND input.context_only=0 AND ${where.sql}`,
          id,
          ...where.params,
        );
        for (const overlap of overlaps) sources.add(String(overlap.episode_id));
        this.store.run(
          "UPDATE memory_episodes SET content='',context='',error=NULL,retry_at=NULL,status='forgotten' WHERE id=?",
          id,
        );
      }
      for (const id of sources) {
        const factIds = this.store
          .all('SELECT fact_id FROM memory_fact_sources WHERE episode_id=?', id)
          .map((row) => String(row.fact_id));
        // Remove derived facts even with other corroborating sources: otherwise a forgotten statement can survive in a summary.
        for (const factId of factIds) {
          this.store.run('DELETE FROM memory_fts WHERE fact_id=?', factId);
          this.store.run('DELETE FROM memory_facts WHERE id=?', factId);
          this.store.run(
            'UPDATE memory_facts SET superseded_by=NULL WHERE superseded_by=?',
            factId,
          );
        }
        // Overlapping batches are invalidated without making their unrelated messages tombstones.
        this.store.run(
          "UPDATE memory_episodes SET content='',context='',error=NULL,retry_at=NULL,status='complete' WHERE id=? AND status!='forgotten'",
          id,
        );
      }
      if (forgotten) {
        this.store.run('DELETE FROM memory_recalls WHERE workspace_id=?', scope.workspaceId);
        this.store.pruneEntities();
        this.store.clearVectors();
      }
    });
    return forgotten;
  }
  clear(scope: MemoryScope) {
    const where = this.store.scope(scope, 'e');
    this.forgetEpisodes(
      scope,
      this.store
        .all(`SELECT id FROM memory_episodes e WHERE ${where.sql}`, ...where.params)
        .map((row) => String(row.id)),
    );
  }
}
