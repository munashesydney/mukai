import { createHash, randomUUID } from 'node:crypto';
import { extractionSchema } from '../extraction/schema';
import { redactCredentials } from '../extraction/redact';
import { normalize, SQLiteMemoryStore } from '../storage/sqlite';
import type {
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

const date = (value: string) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid memory date.');
  return parsed.toISOString();
};
const activeAt = (fact: MemoryFact, at: string) =>
  fact.validFrom <= at && (!fact.validTo || fact.validTo > at);
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
      "UPDATE memory_episodes SET status='processing',attempts=attempts+1,error=NULL WHERE id=?",
      id,
    );
    try {
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
      this.store.run(
        "UPDATE memory_episodes SET status=?,error=? WHERE id=? AND status='processing'",
        signal?.aborted ? 'pending' : 'failed',
        signal?.aborted ? null : 'Memory extraction failed. Check the configured model and retry.',
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
  ) {
    const from = date(fact.validFrom || referenceTime);
    let to = fact.validTo ? date(fact.validTo) : null;
    if (to && to <= from) throw new Error('A memory end must follow its start.');
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
    const duplicate = this.store
      .all(
        'SELECT * FROM memory_facts WHERE workspace_id=? AND owner_id IS ? AND subject_id=? AND relation=? AND object_id=?',
        workspaceId,
        ownerId,
        subjectId,
        relation,
        objectId,
      )
      .find(
        (row) =>
          normalize(String(row.text)) === normalize(fact.text) &&
          (!row.valid_to || String(row.valid_to) > from) &&
          String(row.valid_from) <= from &&
          row.state === (fact.disposition === 'uncertain' ? 'uncertain' : 'confirmed') &&
          (row.valid_to || null) === to,
      );
    const replaces = fact.disposition === 'replace' || fact.disposition === 'correct';
    if (duplicate && !replaces) {
      this.store.run(
        'INSERT OR IGNORE INTO memory_fact_sources VALUES(?,?)',
        String(duplicate.id),
        episodeId,
      );
      return String(duplicate.id);
    }
    const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const targets = replaces
      ? fact.supersedes
          .map((id) => allowed.get(id))
          .filter((target): target is MemoryFact =>
            Boolean(
              target &&
              target.workspaceId === workspaceId &&
              target.ownerId === ownerId &&
              target.subjectId === subjectId &&
              target.relation === relation &&
              (explicitCorrection || target.state === 'confirmed'),
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
    const state =
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
      state,
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
  episodeFacts(scope: MemoryScope, episodeId: string) {
    return this.store
      .facts(scope)
      .filter((fact) => fact.sources.some((source) => source.id === episodeId));
  }
  async indexEmbeddings(scope: MemoryScope, signal?: AbortSignal) {
    if (!this.embedder) return 0;
    const rows = this.store
      .rows(scope)
      .filter((row) => row.vector_model !== this.embedder!.model || !row.vector_json);
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
        count++;
      });
    }
    return count;
  }
  async searchMemory(
    scope: MemoryScope,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(100, options.limit || 12));
    const at = date(options.asOf || new Date().toISOString());
    const rows = this.store
      .rows(scope)
      .filter(
        (row) =>
          (options.includeUncertain || row.state === 'confirmed') &&
          ((!options.asOf && options.includeHistory) ||
            (String(row.valid_from) <= at && (!row.valid_to || String(row.valid_to) > at))),
      );
    const words = tokens(query).slice(0, 40);
    const results = new Map<string, SearchHit>();
    const rank = new Map<string, number>();
    if (words.length) {
      // FTS terms are quoted, never interpolated into SQL or parsed as operators.
      const where = this.store.scope(scope);
      const matches = this.store.all(
        `SELECT memory_fts.fact_id,bm25(memory_fts) AS rank FROM memory_fts JOIN memory_facts f ON f.id=memory_fts.fact_id WHERE memory_fts MATCH ? AND ${where.sql} ORDER BY rank LIMIT 300`,
        words.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR '),
        ...where.params,
      );
      matches.forEach((row, index) => rank.set(String(row.fact_id), index));
    }
    const add = (row: Record<string, string | number | null>, score: number, reason: string) => {
      const id = String(row.id);
      const hit = results.get(id);
      if (hit) {
        hit.score += score;
        hit.reasons.push(reason);
      } else results.set(id, { fact: this.store.fact(row), score, reasons: [reason] });
    };
    for (const row of rows) {
      const position = rank.get(String(row.id));
      if (position !== undefined) add(row, 1 / (30 + position), 'keyword');
      if (
        words.some((word) =>
          [normalize(String(row.subject)), normalize(String(row.object))].includes(word),
        )
      )
        add(row, 0.025, 'entity');
    }
    if (
      query.trim() &&
      this.embedder &&
      rows.some((row) => row.vector_model === this.embedder!.model && row.vector_json)
    ) {
      try {
        const [vector] = await this.embedder.embed([query.slice(0, 2000)], 'query');
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        const semantic = rows
          .filter((row) => row.vector_model === this.embedder!.model && row.vector_json)
          .map((row) => {
            const stored: number[] = JSON.parse(String(row.vector_json));
            const denominator =
              norm * Math.sqrt(stored.reduce((sum, value) => sum + value * value, 0));
            return {
              row,
              similarity:
                stored.length === vector.length && denominator
                  ? stored.reduce((sum, value, index) => sum + value * vector[index], 0) /
                    denominator
                  : 0,
            };
          })
          .filter((item) => item.similarity >= 0.65)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 60);
        semantic.forEach(({ row }, index) => add(row, 1 / (30 + index), 'semantic'));
      } catch {
        /* Keyword and graph retrieval remain usable offline. */
      }
    }
    const seeds = [...results.values()].sort((a, b) => b.score - a.score).slice(0, 4);
    const entities = new Set(seeds.flatMap((hit) => [hit.fact.subjectId, hit.fact.objectId]));
    // A single bounded hop avoids unrelated graph neighborhoods overwhelming recall.
    for (const row of rows
      .filter((row) => entities.has(String(row.subject_id)) || entities.has(String(row.object_id)))
      .slice(0, 24))
      if (!results.has(String(row.id))) add(row, 0.006, 'related entity');
    if (!query.trim()) rows.slice(0, limit).forEach((row) => add(row, 0.001, 'recent'));
    return [...results.values()]
      .sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt))
      .slice(0, limit);
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
    options: { focus?: string; includeHistory?: boolean; limit?: number } = {},
  ): MemoryGraph {
    const now = new Date().toISOString();
    let edges = this.store
      .facts(scope)
      .filter((fact) => options.includeHistory || activeAt(fact, now));
    if (options.focus)
      edges = edges.filter(
        (fact) => fact.subjectId === options.focus || fact.objectId === options.focus,
      );
    const limit = Math.max(1, Math.min(300, options.limit || 100));
    const truncated = edges.length > limit;
    edges = edges.slice(0, limit);
    const ids = new Set(edges.flatMap((fact) => [fact.subjectId, fact.objectId]));
    const nodes = this.store
      .all('SELECT * FROM memory_entities WHERE workspace_id=?', scope.workspaceId)
      .filter((row) => ids.has(String(row.id)))
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
    return this.store.transaction(() =>
      facts.map((fact) => {
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
        if (episode.status !== 'complete' && episode.status !== 'forgotten') {
          this.commit(
            workspaceId,
            fact.ownerId || null,
            episode.id,
            parsed,
            episode.referenceTime,
            [],
          );
          this.store.run("UPDATE memory_episodes SET status='complete' WHERE id=?", episode.id);
        }
        return episode.id;
      }),
    );
  }
  forgetMemory(scope: MemoryScope, id: string) {
    const fact = this.store.requireFact(scope, id);
    this.forgetEpisodes(
      scope,
      fact.sources.map((source) => source.id),
    );
  }
  forgetEpisodes(scope: MemoryScope, ids: string[]) {
    const where = this.store.scope(scope, 'e');
    this.store.transaction(() => {
      for (const id of ids) {
        if (
          !this.store.get(
            `SELECT id FROM memory_episodes e WHERE ${where.sql} AND id=?`,
            ...where.params,
            id,
          )
        )
          continue;
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
        this.store.run(
          "UPDATE memory_episodes SET content='',context='',error=NULL,status='forgotten' WHERE id=?",
          id,
        );
      }
      this.store.run('DELETE FROM memory_recalls WHERE workspace_id=?', scope.workspaceId);
      this.store.pruneEntities();
    });
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
