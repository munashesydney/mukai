import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryEngine,
  SQLiteMemoryStore,
  type EpisodeInput,
  type ExtractedFact,
  type Extractor,
} from '../src';

let db: DatabaseSync, store: SQLiteMemoryStore, engine: MemoryEngine;
let next: ExtractedFact[];
const fact = (object: string, patch: Partial<ExtractedFact> = {}): ExtractedFact => ({
  subject: 'Mukai',
  subjectType: 'project',
  subjectAliases: [],
  relation: 'uses_database',
  object,
  objectType: 'tool',
  objectAliases: [],
  text: `Mukai uses ${object}.`,
  validFrom: null,
  validTo: null,
  disposition: 'assert',
  supersedes: [],
  ...patch,
});
const input = (key: string, patch: Partial<EpisodeInput> = {}): EpisodeInput => ({
  workspaceId: 'one',
  sourceKey: key,
  sourceType: 'user',
  content: key,
  referenceTime: '2026-01-01T00:00:00Z',
  ...patch,
});
async function add(key: string, value: ExtractedFact[], patch: Partial<EpisodeInput> = {}) {
  next = value;
  return engine.addMemory(input(key, patch));
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  store = new SQLiteMemoryStore(db);
  engine = new MemoryEngine(store, async () => ({ facts: next }));
  next = [];
});
afterEach(() => db.close());

describe('Temporal graph memory', () => {
  it('keeps a paused workspace from starving capture in other workspaces', () => {
    for (let index = 0; index < 12; index++) engine.enqueue(input(`paused-${index}`));
    const active = engine.enqueue(input('active', { workspaceId: 'two' }));
    expect(store.pendingEpisodes(8, ['two']).map((episode) => episode.id)).toEqual([active.id]);
    expect(store.pendingEpisodes(8, [])).toEqual([]);
  });
  it('allows a human correction to resolve an uncertain fact', async () => {
    const [old] = await add('uncertain', [fact('SQLite', { disposition: 'uncertain' })]);
    const corrected = engine.correctMemory({ workspaceId: 'one' }, old.id, {
      object: 'Postgres',
      text: 'Mukai uses Postgres.',
      validFrom: '2026-02-01T00:00:00Z',
    });
    expect(corrected.state).toBe('confirmed');
    expect(store.requireFact({ workspaceId: 'one' }, old.id).supersededBy).toBe(corrected.id);
    expect(
      (await engine.searchMemory({ workspaceId: 'one' }, 'database')).map((hit) => hit.fact.id),
    ).toEqual([corrected.id]);
  });
  it('bounds non-ASCII recall by UTF-8 bytes', async () => {
    await add('unicode', [fact('日本語', { text: 'Mukai uses 日本語. '.repeat(12) })]);
    const full = await engine.getContext({ workspaceId: 'one' }, 'Mukai', 2000);
    expect(full.hits).toHaveLength(1);
    const budget = full.content.length;
    expect(Buffer.byteLength(full.content, 'utf8')).toBeGreaterThan(budget);
    expect((await engine.getContext({ workspaceId: 'one' }, 'Mukai', budget)).hits).toHaveLength(0);
  });
  it('redacts recognizable credentials before extraction and storage', async () => {
    const extractor = vi.fn<Extractor>(async () => ({ facts: [] }));
    engine = new MemoryEngine(store, extractor);
    await engine.addMemory(
      input('credentials', {
        content: 'My password is super-secret. API key: sk-abcdefghijklmnop12345',
        context: 'Authorization: Bearer private-token',
      }),
    );
    const call = extractor.mock.calls[0][0];
    expect(call.episode.content).not.toContain('super-secret');
    expect(call.episode.content).not.toContain('sk-abcdefghijklmnop12345');
    expect(call.episode.context).not.toContain('private-token');
    expect(store.all('SELECT content FROM memory_episodes')[0].content).toBe('');
  });
  it('keeps a stale extraction from overwriting an intervening explicit correction', async () => {
    const [old] = await add('old', [fact('SQLite')]);
    let resolve!: (result: { facts: ExtractedFact[] }) => void;
    engine = new MemoryEngine(
      store,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const queued = engine.addMemory(input('new', { referenceTime: '2026-02-01T00:00:00Z' }));
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const corrected = engine.correctMemory({ workspaceId: 'one' }, old.id, {
      object: 'MySQL',
      text: 'Mukai uses MySQL.',
      validFrom: '2026-03-01T00:00:00Z',
    });
    resolve({ facts: [fact('Postgres', { disposition: 'replace', supersedes: [old.id] })] });
    await queued;
    expect(store.requireFact({ workspaceId: 'one' }, old.id).supersededBy).toBe(corrected.id);
    expect(
      store.facts({ workspaceId: 'one' }).find((value) => value.object === 'Postgres')?.state,
    ).toBe('uncertain');
  });
  it('supersedes a fact while preserving provenance and historical recall', async () => {
    const [old] = await add('original', [fact('SQLite')]);
    const [current] = await add(
      'we switched',
      [fact('Postgres', { disposition: 'replace', supersedes: [old.id] })],
      { referenceTime: '2026-02-01T00:00:00Z' },
    );
    expect(store.requireFact({ workspaceId: 'one' }, old.id)).toMatchObject({
      validTo: '2026-02-01T00:00:00.000Z',
      supersededBy: current.id,
    });
    expect(
      (await engine.searchMemory({ workspaceId: 'one' }, 'Mukai database')).map(
        (hit) => hit.fact.object,
      ),
    ).toEqual(['Postgres']);
    expect(
      (
        await engine.searchMemory({ workspaceId: 'one' }, 'Mukai database', {
          asOf: '2026-01-15T00:00:00Z',
        })
      ).map((hit) => hit.fact.object),
    ).toEqual(['SQLite']);
    expect(current.sources[0].content).toBe('we switched');
  });
  it('does not let a backdated change invalidate a later fact', async () => {
    const [recent] = await add('recent', [fact('Postgres')], {
      referenceTime: '2026-03-01T00:00:00Z',
    });
    const [historical] = await add(
      'historical',
      [fact('SQLite', { disposition: 'replace', supersedes: [recent.id] })],
      { referenceTime: '2026-01-01T00:00:00Z' },
    );
    expect(historical.validTo).toBe('2026-03-01T00:00:00.000Z');
    expect(store.requireFact({ workspaceId: 'one' }, recent.id).validTo).toBeNull();
  });
  it('keeps independent relationships and uncertain conflicts separate', async () => {
    await add('projects', [
      fact('A', { relation: 'works_on' }),
      fact('B', { relation: 'works_on' }),
      fact('maybe', { disposition: 'uncertain' }),
    ]);
    const hits = await engine.searchMemory({ workspaceId: 'one' }, 'Mukai');
    expect(hits.map((hit) => hit.fact.object).sort()).toEqual(['A', 'B']);
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(3);
  });
  it('cannot supersede another subject, owner, relation, or fabricated ID', async () => {
    const [old] = await add('original', [fact('SQLite')]);
    await add('malicious', [
      fact('Postgres', {
        subject: 'Another project',
        disposition: 'replace',
        supersedes: [old.id, 'invented'],
      }),
    ]);
    expect(store.requireFact({ workspaceId: 'one' }, old.id).validTo).toBeNull();
    expect(
      store.facts({ workspaceId: 'one' }).find((value) => value.subject === 'Another project')
        ?.state,
    ).toBe('uncertain');
  });
  it('isolates private and workspace memories in search, graph, and provenance', async () => {
    const [privateFact] = await add('secret', [fact('Private database')], { ownerId: 'bot-a' });
    await add('public', [fact('Shared database')]);
    await add('other workspace', [fact('Other database')], { workspaceId: 'two' });
    expect(
      (await engine.searchMemory({ workspaceId: 'one' }, 'database')).map((hit) => hit.fact.object),
    ).toEqual(['Shared database']);
    expect(
      (await engine.searchMemory({ workspaceId: 'one', privateOwner: 'bot-b' }, 'database')).map(
        (hit) => hit.fact.object,
      ),
    ).toEqual(['Shared database']);
    expect(
      engine
        .getGraph({ workspaceId: 'one' })
        .nodes.some((node) => node.name === 'Private database'),
    ).toBe(false);
    expect(() => store.requireFact({ workspaceId: 'one' }, privateFact.id)).toThrow('scope');
    expect(store.facts({ workspaceId: 'one', privateOwner: 'bot-a' })).toHaveLength(2);
  });
  it('is idempotent on source replay and links corroborating episodes', async () => {
    const extract = vi.fn<Extractor>(async () => ({ facts: [fact('SQLite')] }));
    engine = new MemoryEngine(store, extract);
    await engine.addMemory(input('same'));
    await engine.addMemory(input('same'));
    await engine.addMemory(input('corroboration', { referenceTime: '2026-02-01T00:00:00Z' }));
    expect(extract).toHaveBeenCalledTimes(2);
    const facts = store.facts({ workspaceId: 'one' });
    expect(facts).toHaveLength(1);
    expect(facts[0].sources).toHaveLength(2);
  });
  it('commits extraction atomically when one fact has invalid temporal bounds', async () => {
    await expect(
      add('invalid', [
        fact('SQLite'),
        fact('Postgres', { validFrom: '2026-02-01T00:00:00Z', validTo: '2026-01-01T00:00:00Z' }),
      ]),
    ).rejects.toThrow();
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(0);
    expect(store.all('SELECT * FROM memory_entities')).toHaveLength(0);
    expect(store.all('SELECT status FROM memory_episodes')[0].status).toBe('failed');
  });
  it('forgets source-derived facts, vectors and traces, and blocks replay', async () => {
    const [old] = await add('original', [
      fact('SQLite'),
      fact('TypeScript', { relation: 'uses_language' }),
    ]);
    store.run(
      'INSERT INTO memory_recalls VALUES(?,?,?,?,?,?,?,?,?)',
      'recall',
      'one',
      null,
      'conversation',
      'message',
      'now',
      'secret',
      '[]',
      0,
    );
    engine.forgetMemory({ workspaceId: 'one' }, old.id);
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(0);
    expect(store.all('SELECT * FROM memory_fts')).toHaveLength(0);
    expect(store.all('SELECT * FROM memory_entities')).toHaveLength(0);
    expect(store.recalls({ workspaceId: 'one' })).toHaveLength(0);
    await add('original', [fact('SQLite')]);
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(0);
    expect(store.all('SELECT content,status FROM memory_episodes')[0]).toMatchObject({
      content: '',
      status: 'forgotten',
    });
  });
  it('cannot reintroduce an episode forgotten during extraction', async () => {
    let resolve!: (result: { facts: ExtractedFact[] }) => void;
    engine = new MemoryEngine(
      store,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const episode = engine.enqueue(input('race'));
    const processing = engine.processEpisode(episode.id);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    engine.forgetEpisodes({ workspaceId: 'one' }, [episode.id]);
    resolve({ facts: [fact('SQLite')] });
    await processing;
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(0);
  });
  it('serializes concurrent changes in the same graph scope', async () => {
    const callback = vi.fn<Extractor>(async ({ episode, candidates }) => ({
      facts: [
        fact(episode.content, {
          disposition: candidates.length ? 'replace' : 'assert',
          supersedes: candidates.map((item) => item.id),
        }),
      ],
    }));
    engine = new MemoryEngine(store, callback);
    await Promise.all([
      engine.addMemory(input('SQLite')),
      engine.addMemory(input('Postgres', { referenceTime: '2026-02-01T00:00:00Z' })),
    ]);
    expect(callback.mock.calls[1][0].candidates).toHaveLength(1);
    expect(
      (await engine.searchMemory({ workspaceId: 'one' }, 'database')).map((hit) => hit.fact.object),
    ).toEqual(['Postgres']);
  });
  it('expands relevant relationships and respects the context budget', async () => {
    await add('connected', [
      fact('Mukai', { subject: 'Alex', relation: 'works_on', text: 'Alex works on Mukai.' }),
      fact('SQLite'),
    ]);
    const hits = await engine.searchMemory({ workspaceId: 'one' }, 'Alex');
    expect(
      hits.some((hit) => hit.fact.object === 'SQLite' && hit.reasons.includes('related entity')),
    ).toBe(true);
    const context = await engine.getContext({ workspaceId: 'one' }, 'Alex', 240);
    expect(context.content.length).toBeLessThanOrEqual(240);
  });
  it('supports CPU-independent embedding adapters and semantic retrieval', async () => {
    const embed = vi.fn(async (texts: string[], kind: string) =>
      texts.map((text) => (kind === 'query' || text.includes('espresso') ? [1, 0] : [0, 1])),
    );
    engine = new MemoryEngine(store, async () => ({ facts: next }), {
      model: 'test-embedding',
      embed,
    });
    await add('semantic', [
      fact('espresso', { subject: 'User', relation: 'prefers', text: 'User prefers espresso.' }),
    ]);
    await engine.indexEmbeddings({ workspaceId: 'one' });
    const result = await engine.searchMemory({ workspaceId: 'one' }, 'morning beverage');
    expect(result[0].fact.object).toBe('espresso');
    expect(result[0].reasons).toContain('semantic');
  });
  it('imports facts transactionally without calling an LLM and preserves private ownership', () => {
    const extraction = vi.fn<Extractor>();
    engine = new MemoryEngine(store, extraction);
    const value = {
      subject: 'User',
      relation: 'prefers',
      object: 'tea',
      text: 'User prefers tea.',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      state: 'confirmed' as const,
      ownerId: 'bot-a',
    };
    engine.importFacts('one', [value]);
    engine.importFacts('one', [value]);
    expect(extraction).not.toHaveBeenCalled();
    expect(store.facts({ workspaceId: 'one' })).toHaveLength(0);
    expect(store.facts({ workspaceId: 'one', privateOwner: 'bot-a' })).toHaveLength(1);
  });
  it('supports explicit corrections at the same effective time', async () => {
    const [old] = await add('original', [fact('SQLite')]);
    const corrected = engine.correctMemory({ workspaceId: 'one' }, old.id, {
      object: 'Postgres',
      text: 'Mukai uses Postgres.',
      validFrom: old.validFrom,
    });
    expect(store.requireFact({ workspaceId: 'one' }, old.id).supersededBy).toBe(corrected.id);
    expect(
      (await engine.searchMemory({ workspaceId: 'one' }, 'database')).map((hit) => hit.fact.object),
    ).toEqual(['Postgres']);
  });
});
