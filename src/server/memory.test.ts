import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import type { Bot, ChatEvent } from '../shared/ai';
import type { MemorySnapshot } from '../shared/memory';
import type { ExtractedFact, Extractor } from '../../mukai_memory/src';
import { CAPTURE_ATTEMPT_LIMIT, MemoryEngine } from '../../mukai_memory/src';
import { memoryTools } from './tools/memory/execute';
import { memoryDefinition } from './tools/memory/definition';
import { MemoryReviewService } from './services/memoryReviewService';
import { BotRepository } from './repositories/botRepository';

const coffee: ExtractedFact = {
  subject: 'User',
  subjectId: null,
  subjectType: 'person',
  subjectAliases: [],
  relation: 'prefers_coffee',
  object: 'espresso',
  objectId: null,
  objectType: 'preference',
  objectAliases: [],
  text: 'User prefers espresso every morning.',
  validFrom: null,
  validTo: null,
  disposition: 'assert',
  supersedes: [],
};
const extractor: Extractor = async ({ episode }) => ({
  facts: episode.content.includes('espresso') ? [coffee] : [],
});
/** One claim about one triple, so a test can vary only the part it is about. */
const cache = (
  validFrom: string,
  disposition: ExtractedFact['disposition'] = 'assert',
  supersedes: string[] = [],
  over: Partial<ExtractedFact> = {},
): ExtractedFact => ({
  subject: 'Gateway',
  subjectId: null,
  subjectType: 'system',
  subjectAliases: [],
  relation: 'runs_cache',
  object: 'redis',
  objectId: null,
  objectType: 'thing',
  objectAliases: [],
  text: 'The gateway runs on Redis.',
  validFrom,
  validTo: null,
  disposition,
  supersedes,
  ...over,
});
/**
 * The shape the write path used to allow: one more served row for a claim the workspace already had,
 * reached through its own source. The guard stops new ones, so a test plants the legacy rows directly.
 */
const plantTwin = (
  id: string,
  over: { validFrom?: string; validTo?: string | null; state?: string } = {},
) => {
  const original = api.memory.store.get('SELECT * FROM memory_facts WHERE id=?', id)!;
  const episode = api.memory.store.get(
    'SELECT * FROM memory_episodes WHERE id=(SELECT episode_id FROM memory_fact_sources WHERE fact_id=? LIMIT 1)',
    id,
  )!;
  const source = randomUUID();
  api.memory.store.run(
    `INSERT INTO memory_episodes(id,workspace_id,source_key,source_type,content,reference_time,context,
      created_at,status,attempts)
     VALUES(?,?,?,?,?,?,?,?,'complete',1)`,
    source,
    String(episode.workspace_id),
    `legacy-${source}`,
    String(episode.source_type),
    'Checked the gateway deployment.',
    String(episode.reference_time),
    '',
    new Date().toISOString(),
  );
  const twin = randomUUID();
  api.memory.store.run(
    `INSERT INTO memory_facts(id,workspace_id,owner_id,subject_id,relation,object_id,text,valid_from,
      valid_to,created_at,superseded_by,state,vector_json,vector_model)
     SELECT ?,workspace_id,owner_id,subject_id,relation,object_id,text,?,?,?,NULL,?,NULL,NULL
     FROM memory_facts WHERE id=?`,
    twin,
    over.validFrom ?? String(original.valid_from),
    over.validTo === undefined ? null : over.validTo,
    new Date().toISOString(),
    over.state ?? String(original.state),
    id,
  );
  api.memory.store.run('INSERT INTO memory_fact_sources VALUES(?,?)', twin, source);
  api.memory.store.run(
    'INSERT INTO memory_fts(fact_id,text) VALUES(?,?)',
    twin,
    String(original.text),
  );
  return { twin, source };
};
let dir: string, api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server;
let calls: {
  messages: { role: string; content: unknown }[];
  stream?: boolean;
  response_format?: unknown;
  max_tokens?: number;
  tools?: { function: { name: string } }[];
  thinking?: { type: string };
  enable_thinking?: boolean;
}[];
let invalidSchema = false;
let extractionResponses: { content: string | null; finishReason: string; abort?: () => void }[];
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function request<T>(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { response, data: (await response.json()) as T };
}
async function chat(text: string, requestId = randomUUID()) {
  const response = await fetch(api.url + '/bots/scout/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestId, attachmentIds: [] }),
  });
  expect(response.ok).toBe(true);
  return {
    requestId,
    events: (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatEvent),
  };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-memory-test-'));
  calls = [];
  invalidSchema = false;
  extractionResponses = [];
  fixture = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    calls.push(body);
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-memory',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null },
            ],
          }) +
          '\n\n',
      );
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-memory',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else {
      const simulated = extractionResponses.shift();
      if (simulated?.abort) {
        simulated.abort();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'test-memory',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: simulated
                  ? simulated.content
                  : invalidSchema
                    ? 'not json'
                    : JSON.stringify({
                        facts: [coffee],
                        reviewSummary: 'Retain the explicitly stated coffee preference.',
                      }),
              },
              finish_reason: simulated?.finishReason ?? 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  api = await startApiServer(0, {
    dataDir: dir,
    memoryExtractor: extractor,
    memoryReviewIdleMs: 0,
  });
  seedTestBot(api.store);
  await request('/providers', 'POST', {
    name: 'Memory fixture',
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
    defaultModel: 'test-memory',
    contextWindowTokens: 128000,
    maxOutputTokens: 48000,
    supportsImages: false,
    isDefault: true,
    apiKey: '',
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close(api.server);
  await close(fixture);
  expect(dir.startsWith(join(tmpdir(), 'mukai-memory-test-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('Mukai memory integration', () => {
  it('aborts in-flight extraction when disabled and supports new work after re-enabling', async () => {
    await close(api.server);
    let release!: () => void;
    let activeSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api = await startApiServer(0, {
      dataDir: dir,
      memoryExtractor: async ({ signal }) => {
        activeSignal = signal;
        await gate;
        return { facts: [coffee] };
      },
    });
    const bot = (await request<Bot[]>('/bots')).data[0];
    try {
      await api.memory.add(
        bot,
        'bot-scout',
        'in-flight',
        'espresso',
        'in-flight',
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(activeSignal).toBeDefined());
      api.memory.saveSettings('default', { ...api.memory.settings('default'), enabled: false });
      expect(activeSignal?.aborted).toBe(true);
      release();
      await vi.waitFor(() =>
        expect(api.memory.snapshot('default').episodes[0].status).toBe('failed'),
      );
      expect(api.memory.snapshot('default').facts).toHaveLength(0);
      api.memory.saveSettings('default', { ...api.memory.settings('default'), enabled: true });
      await api.memory.add(
        bot,
        'bot-scout',
        'after-enable',
        'espresso',
        'after-enable',
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
      expect(activeSignal?.aborted).toBe(false);
    } finally {
      release();
    }
  });
  it('turns off capture, recall, and bot memory access while keeping saved facts and preferences', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const before = api.memory.settings('default');
    const saved = await request('/memory/settings', 'PUT', { ...before, enabled: false });
    expect(saved.response.status).toBe(200);
    await chat('My off-period secret is marmalade.');
    const last = calls.filter((call) => call.stream).at(-1)!;
    expect(JSON.stringify(last.messages)).not.toContain('Retrieved memory reference');
    expect(last.tools?.some((entry) => entry.function.name === 'memory')).toBe(false);
    const bot = (await request<Bot[]>('/bots')).data[0];
    await expect(
      api.memory.add(bot, 'bot-scout', 'off', 'espresso', 'off', new AbortController().signal),
    ).rejects.toThrow('Memory is off');
    await expect(api.memory.search(bot, 'espresso', {})).rejects.toThrow('Memory is off');
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect(api.memory.settings('default')).toEqual({ ...before, enabled: false });
    await close(api.server);
    api = await startApiServer(0, {
      dataDir: dir,
      memoryExtractor: extractor,
      memoryReviewIdleMs: 0,
    });
    expect(api.memory.settings('default').enabled).toBe(false);
    await request('/memory/settings', 'PUT', before);
    expect(api.memory.settings('default')).toEqual(before);
    await chat('Continue with future exchanges.');
    await api.memory.reviews.drain(new AbortController().signal);
    expect(
      api.memory
        .snapshot('default')
        .episodes.some((episode) => episode.content.includes('marmalade')),
    ).toBe(false);
  });
  it('excludes saved facts from provider requests when memory is off, including prior recalls', async () => {
    const imported = await request('/memory/import', 'POST', {
      version: 1,
      facts: [
        {
          subject: coffee.subject,
          relation: coffee.relation,
          object: coffee.object,
          text: coffee.text,
          validFrom: '2026-01-01T00:00:00Z',
          validTo: null,
          state: 'confirmed',
        },
      ],
    });
    expect(imported.response.ok).toBe(true);
    // The saved fact never appears in user messages or the fixture's "OK" replies.
    await chat('What coffee do I like?');
    const enabled = calls.filter((call) => call.stream).at(-1)!;
    expect(JSON.stringify(enabled.messages)).toContain(coffee.text);
    const settings = api.memory.settings('default');
    await request('/memory/settings', 'PUT', { ...settings, enabled: false });
    const recalls = api.memory.snapshot('default').recalls.length;
    await chat('What coffee do I like?');
    const disabled = calls.filter((call) => call.stream).at(-1)!;
    expect(JSON.stringify(disabled.messages)).not.toContain(coffee.text);
    expect(JSON.stringify(disabled.messages)).not.toContain('Retrieved memory reference');
    expect(JSON.stringify(disabled.messages)).toContain('Memory off');
    expect(JSON.stringify(disabled.messages)).toContain('What coffee do I like?');
    expect(disabled.tools?.some((entry) => entry.function.name === 'memory')).toBe(false);
    expect(api.memory.snapshot('default').recalls).toHaveLength(recalls);
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    await request('/memory/settings', 'PUT', settings);
    await chat('What coffee do I like?');
    expect(JSON.stringify(calls.filter((call) => call.stream).at(-1)!.messages)).toContain(
      coffee.text,
    );
  });
  it('serializes overlapping review requests across private and workspace conversations', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('I prefer espresso.');
    api.store.run(
      "INSERT INTO conversations(id,workspace_id,kind,name,description,created_at,updated_at) VALUES('queue-space','default','space','Queue check','','now','now')",
    );
    api.store.run(
      "INSERT INTO messages(id,conversation_id,request_id,role,content,status,created_at) VALUES('queue-message','queue-space','queue-request','user','Project finding','complete','2026-10-04T00:00:00Z')",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    let active = 0,
      peak = 0;
    const engine = new MemoryEngine(api.memory.store, async ({ episode }) => {
      order.push(episode.conversationId!);
      peak = Math.max(peak, ++active);
      if (order.length === 1) await gate;
      active--;
      return { facts: [] };
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    worker.schedule('default', 'queue-space', 'scout');
    const first = worker.drain(new AbortController().signal);
    await vi.waitFor(() => expect(order).toEqual(['bot-scout']));
    const overlapping = worker.drain(new AbortController().signal);
    expect(overlapping).toBe(first);
    expect(worker.list('default')).toHaveLength(1);
    release();
    await Promise.all([first, overlapping]);
    expect(order).toEqual(['bot-scout', 'queue-space']);
    expect(peak).toBe(1);
    expect(worker.list('default')).toHaveLength(2);
    expect(worker.list('default').every((run) => run.status === 'complete')).toBe(true);
    await worker.drain(new AbortController().signal);
    expect(order).toHaveLength(2);
  });
  it('indexes reviewed facts locally and respects semantic search opt-out', async () => {
    api.memory.embedding.ready = true;
    const embed = vi
      .spyOn(api.memory.embedding, 'embed')
      .mockImplementation(async (texts) => texts.map(() => [1, ...Array<number>(383).fill(0)]));
    api.memory.saveSettings('default', { ...api.memory.settings('default'), semanticSearch: true });
    await chat('I prefer espresso.');
    await vi.waitFor(() =>
      expect(
        api.memory.store.get('SELECT vector_json FROM memory_facts LIMIT 1')?.vector_json,
      ).toBeTruthy(),
    );
    expect(embed.mock.calls.some((call) => call[1] === 'document')).toBe(true);
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      semanticSearch: false,
    });
    embed.mockClear();
    await chat('Espresso is still my preference.');
    await vi.waitFor(() => expect(api.memory.reviews.list('default')).toHaveLength(2));
    expect(embed).not.toHaveBeenCalled();
  });
  it('does not resurrect a source when memory is cleared during a review', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('I prefer espresso.');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let extracting = false;
    const engine = new MemoryEngine(api.memory.store, async () => {
      extracting = true;
      await gate;
      return { facts: [coffee] };
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    const running = worker.drain(new AbortController().signal);
    await vi.waitFor(() => expect(extracting).toBe(true));
    api.memory.clear('default');
    release();
    await running;
    expect(api.memory.snapshot('default').facts).toHaveLength(0);
    expect(worker.list('default')).toHaveLength(0);
  });
  it('holds a failed review checkpoint until retry succeeds', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('I prefer espresso.');
    let attempts = 0;
    const engine = new MemoryEngine(api.memory.store, async () => {
      if (++attempts === 1) throw new Error('Fixture failure');
      return { facts: [coffee] };
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    await worker.drain(new AbortController().signal);
    const failed = worker.list('default')[0];
    expect(failed.status).toBe('failed');
    expect(
      api.memory.store.get(
        "SELECT checkpoint FROM memory_review_jobs WHERE conversation_id='bot-scout'",
      )?.checkpoint,
    ).toBe(0);
    await worker.drain(new AbortController().signal);
    expect(attempts).toBe(1);
    worker.retry('default', failed.id);
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')[0].status).toBe('complete');
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect(attempts).toBe(2);
  });
  it('resumes a failed review after new chat activity and includes all unreviewed messages', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('I prefer espresso.');
    let attempts = 0;
    const engine = new MemoryEngine(api.memory.store, async () => {
      if (++attempts === 1) throw new Error('Fixture failure');
      return { facts: [coffee] };
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    worker.schedule('default', 'bot-scout', 'scout');
    now.mockReturnValue(61001);
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')[0].status).toBe('failed');
    await worker.drain(new AbortController().signal);
    expect(attempts).toBe(1);

    await chat('I also like coffee in the afternoon.');
    worker.schedule('default', 'bot-scout', 'scout');
    const job = api.memory.store.get(
      "SELECT checkpoint,blocked FROM memory_review_jobs WHERE conversation_id='bot-scout'",
    );
    expect(job).toMatchObject({ checkpoint: 0, blocked: 0 });
    now.mockReturnValue(121000);
    await worker.drain(new AbortController().signal);
    expect(attempts).toBe(1);
    now.mockReturnValue(121002);
    await worker.drain(new AbortController().signal);
    const completed = worker.list('default')[0];
    expect(completed.status).toBe('complete');
    expect(completed.messageIds).toHaveLength(4);
    expect(attempts).toBe(2);
    await worker.drain(new AbortController().signal);
    expect(attempts).toBe(2);
  });
  it('debounces reviews, skips active responses, and checkpoints complete exchanges exactly once', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('I prefer espresso every morning.');
    const worker = new MemoryReviewService(
      api.memory.store,
      api.memory.engine,
      new BotRepository(api.store),
      () => true,
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    worker.schedule('default', 'bot-scout', 'scout');
    now.mockReturnValue(60000);
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')).toHaveLength(0);
    worker.schedule('default', 'bot-scout', 'scout');
    now.mockReturnValue(119999);
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')).toHaveLength(0);
    now.mockReturnValue(120001);
    api.store.run("UPDATE messages SET status='streaming' WHERE role='assistant'");
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')).toHaveLength(0);
    api.store.run("UPDATE messages SET status='complete' WHERE role='assistant'");
    await worker.drain(new AbortController().signal);
    const run = worker.list('default')[0];
    expect(run).toMatchObject({ status: 'complete', ownerId: null, kind: 'private' });
    expect(run.messageIds).toHaveLength(2);
    expect(run.activity.map((activity) => activity.action)).toEqual(['review', 'search', 'add']);
    const episode = api.memory.snapshot('default').episodes[0];
    expect(
      JSON.parse(episode.content).messages.map((message: { role: string }) => message.role),
    ).toEqual(['user', 'assistant']);
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')).toHaveLength(1);
    const restored = new MemoryReviewService(
      api.memory.store,
      api.memory.engine,
      new BotRepository(api.store),
      () => true,
    );
    restored.recover();
    await restored.drain(new AbortController().signal);
    expect(restored.list('default')).toHaveLength(1);
    expect(
      (await request('/memory/runs/retry?workspaceId=other', 'POST', { id: run.id })).response
        .status,
    ).toBe(404);
  });
  it('reviews pursuit findings in workspace scope and records no-change reviews', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('Hello');
    api.store.run("UPDATE conversations SET kind='pursuit_run' WHERE id='bot-scout'");
    const worker = new MemoryReviewService(
      api.memory.store,
      api.memory.engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')[0]).toMatchObject({
      ownerId: null,
      kind: 'pursuit_run',
      status: 'complete',
      summary: 'No durable information needed saving.',
    });
    expect(api.memory.snapshot('default').facts).toHaveLength(0);
    expect(worker.list('default')[0].activity.map((activity) => activity.action)).toEqual([
      'review',
      'search',
    ]);
  });
  it('exposes one memory function and dispatches actions with their required fields', async () => {
    const bot = (await request<Bot[]>('/bots')).data[0];
    const search = vi.spyOn(api.memory, 'search').mockResolvedValue([]);
    const add = vi
      .spyOn(api.memory, 'add')
      .mockResolvedValue({ queued: true, episodeId: 'queued-episode', status: 'pending' });
    const forget = vi.spyOn(api.memory.engine, 'forgetMemory').mockImplementation(() => 1);
    const activities: { tool: string; action: string; status: string }[] = [];
    const tools = memoryTools({
      bot,
      conversationId: 'bot-scout',
      messageId: 'memory-action-check',
      memory: api.memory,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity),
    });
    expect(Object.keys(tools)).toEqual(['memory']);
    const invoke = (input: Parameters<NonNullable<typeof tools.memory.execute>>[0]) =>
      tools.memory.execute!(input, { toolCallId: randomUUID(), messages: [], context: {} });
    for (const action of ['add', 'search', 'forget'] as const) {
      expect(await invoke({ action })).toMatchObject({
        ok: false,
        error: expect.stringContaining('requires'),
      });
    }
    expect(add).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) {
      expect(await invoke({ action: 'add', content: 'User prefers espresso.' })).toMatchObject({
        ok: true,
      });
      expect(add.mock.calls.at(-1)?.[4]).toMatch(/^tool:memory-action-check:/);
    }
    expect(memoryDefinition.inputSchema.shape).not.toHaveProperty('scope');
    const asOf = '2026-02-15T12:00:00Z';
    expect(
      await invoke({ action: 'search', query: 'espresso', limit: 7, asOf, includeHistory: true }),
    ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledWith(bot, 'espresso', {
      limit: 7,
      asOf,
      includeHistory: true,
    });
    const memoryId = randomUUID();
    expect(await invoke({ action: 'forget', memoryId })).toMatchObject({
      ok: true,
      result: { forgotten: true },
    });
    expect(forget).toHaveBeenCalledWith(api.memory.scope(bot), memoryId);
    expect(
      activities
        .filter((activity) => activity.status === 'complete')
        .map((activity) => [activity.tool, activity.action]),
    ).toEqual([
      ['memory', 'add'],
      ['memory', 'add'],
      ['memory', 'search'],
      ['memory', 'forget'],
    ]);
    expect(
      memoryDefinition.inputSchema.safeParse({ action: 'forget', memoryId: 'invalid' }).success,
    ).toBe(false);
    expect(
      memoryDefinition.inputSchema.safeParse({ action: 'search', query: 'espresso', limit: 31 })
        .success,
    ).toBe(false);
    const catalog = (await request<{ id: string; actions: string[] }[]>('/tools')).data;
    expect(catalog.filter((tool) => tool.id.startsWith('memory'))).toEqual([
      expect.objectContaining({ id: 'memory', actions: ['add', 'search', 'forget'] }),
    ]);
  });
  it('allows a multi-scenario investigation to search more than twelve times and still write', async () => {
    const bot = (await request<Bot[]>('/bots')).data[0];
    const search = vi.spyOn(api.memory, 'search').mockResolvedValue([]);
    const add = vi
      .spyOn(api.memory, 'add')
      .mockResolvedValue({ queued: true, episodeId: 'queued-episode', status: 'pending' });
    const tools = memoryTools({
      bot,
      conversationId: 'bot-scout',
      messageId: 'memory-budget-check',
      memory: api.memory,
      signal: new AbortController().signal,
      onActivity: () => {},
    });
    for (let index = 0; index < 13; index++) {
      expect(
        await tools.memory.execute!(
          { action: 'search', query: 'MEMTEST-03 investigation' },
          { toolCallId: `search-${index}`, messages: [], context: {} },
        ),
      ).toMatchObject({ ok: true });
    }
    expect(
      await tools.memory.execute!(
        { action: 'add', content: 'MEMTEST-03 investigation result.' },
        { toolCallId: 'write-after-searches', messages: [], context: {} },
      ),
    ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(13);
    expect(add).toHaveBeenCalledOnce();
  });
  it('captures facts from private chats in workspace memory and automatically recalls them', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    expect(api.memory.snapshot('default').facts[0].ownerId).toBeNull();
    await chat('What coffee do I like?');
    const latest = calls.filter((call) => call.stream).at(-1)!;
    expect(JSON.stringify(latest.messages)).toContain('User prefers espresso every morning.');
    expect(latest.messages[0].role).toBe('system');
    expect(
      latest.tools
        ?.filter((tool) => tool.function.name.startsWith('memory'))
        .map((tool) => tool.function.name),
    ).toEqual(['memory']);
    // Memory guidance lives in the assigned tool description, avoiding duplicate system context.
    expect(JSON.stringify(latest.tools)).toContain('add requires content:');
    expect(JSON.stringify(latest.tools)).toContain('search requires query');
    expect(JSON.stringify(latest.tools)).toContain('forget requires memoryId');
    const snapshot = (await request<MemorySnapshot>('/memory')).data;
    expect(snapshot.recalls[0].facts[0].text).toContain('espresso');
    expect(snapshot.recalls[0].characters).toBeGreaterThan(0);
  });
  it('combines historical and new memory activity counts in the same family', async () => {
    await chat('Hello');
    const activity = [
      { tool: 'memory_add', action: 'add', status: 'complete' },
      { tool: 'memory_search', action: 'search', status: 'complete' },
      { tool: 'memory_forget', action: 'forget', status: 'complete' },
      { tool: 'memory', action: 'add', status: 'complete' },
      { tool: 'memory', action: 'search', status: 'complete' },
      { tool: 'memory', action: 'forget', status: 'complete' },
      { tool: 'memory', action: 'add', status: 'failed' },
    ];
    api.store.run(
      "UPDATE messages SET activity_json=? WHERE bot_id='scout' AND role='assistant'",
      JSON.stringify(activity),
    );
    const catalog = (await request<{ id: string; counts: Record<string, number> }[]>('/tools'))
      .data;
    expect(catalog.find((tool) => tool.id === 'memory')?.counts).toEqual({
      add: 2,
      search: 2,
      forget: 2,
    });
  });
  it('shares memories across bots and chats while keeping workspaces isolated', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const bot = (await request<Bot[]>('/bots')).data[0];
    expect(await api.memory.search(bot, 'espresso', {})).toHaveLength(1);
    const otherBot = { ...bot, id: 'other-bot' };
    expect(await api.memory.search(otherBot, 'espresso', {})).toHaveLength(1);
    // Older memories retain their provenance but are also shared across bots.
    api.memory.store.run("UPDATE memory_facts SET owner_id='scout'");
    expect(await api.memory.search(otherBot, 'espresso', {})).toHaveLength(1);
    const user = api.store.get("SELECT id FROM messages WHERE role='user' LIMIT 1")!;
    expect(
      await api.memory.recall(otherBot, 'bot-scout', String(user.id), 'other-bot-recall', 4096),
    ).toContain('User prefers espresso every morning.');
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other','Other',NULL,'now')",
    );
    const snapshot = (await request<MemorySnapshot>('/memory?workspaceId=other')).data;
    expect(snapshot.facts).toHaveLength(0);
    expect(snapshot.recalls).toHaveLength(0);
    expect(snapshot.settings.enabled).toBe(false);
    api.memory.saveSettings('other', { ...snapshot.settings, enabled: true });
    expect(
      await api.memory.search({ ...otherBot, workspaceId: 'other' }, 'espresso', {}),
    ).toHaveLength(0);
  });
  it('saves explicit tool memories to the workspace without a scope choice', async () => {
    const bot = (await request<Bot[]>('/bots')).data[0];
    const tools = memoryTools({
      bot,
      conversationId: 'bot-scout',
      messageId: 'shared-memory-write',
      memory: api.memory,
      signal: new AbortController().signal,
      onActivity: () => {},
    });
    expect(
      await tools.memory.execute!(
        { action: 'add', content: 'User prefers espresso.' },
        { toolCallId: 'shared-write', messages: [], context: {} },
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const snapshot = api.memory.snapshot('default');
    expect(snapshot.facts[0].ownerId).toBeNull();
    expect(snapshot.episodes[0].ownerId).toBeNull();
    expect(await api.memory.search({ ...bot, id: 'other-bot' }, 'espresso', {})).toHaveLength(1);
  });
  it('acknowledges durable memory adds before extraction and processes them independently of the chat', async () => {
    const bot = (await request<Bot[]>('/bots')).data[0];
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    const caller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.memory.engine.processEpisode.bind(api.memory.engine);
    const processing = vi
      .spyOn(api.memory.engine, 'processEpisode')
      .mockImplementation(async (id, signal) => {
        await gate;
        return original(id, signal);
      });
    const tools = memoryTools({
      bot,
      conversationId: 'bot-scout',
      messageId: 'background-memory',
      memory: api.memory,
      signal: caller.signal,
      onActivity: () => {},
    });
    const invoke = () =>
      tools.memory.execute!(
        { action: 'add', content: 'User prefers espresso.' },
        { toolCallId: 'background-add', messages: [], context: {} },
      );
    try {
      let acknowledged = false;
      const response = Promise.resolve(invoke()).then((result) => {
        acknowledged = true;
        return result;
      });
      await vi.waitFor(() => expect(acknowledged).toBe(true), { timeout: 500 });
      expect(await response).toMatchObject({
        ok: true,
        result: { queued: true, episodeId: expect.any(String), status: 'pending' },
      });
      expect(api.memory.snapshot('default').facts).toHaveLength(0);
      expect(api.memory.snapshot('default').episodes).toHaveLength(1);
      await invoke();
      expect(api.memory.snapshot('default').episodes).toHaveLength(1);
      await vi.waitFor(() => expect(processing).toHaveBeenCalled());
      expect(processing.mock.calls[0][1]).not.toBe(caller.signal);
      caller.abort();
      release();
      await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
      expect(api.memory.snapshot('default').episodes[0].status).toBe('complete');
    } finally {
      release();
    }
  });
  it('honors controls and survives restart without replay', async () => {
    const first = await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    await request('/memory/settings', 'PUT', {
      ...api.memory.settings('default'),
      automaticRecall: false,
      automaticCapture: false,
    });
    await chat('What coffee do I like?');
    expect(JSON.stringify(calls.filter((call) => call.stream).at(-1)!.messages)).not.toContain(
      'Retrieved memory reference',
    );
    await close(api.server);
    api = await startApiServer(0, {
      dataDir: dir,
      memoryExtractor: extractor,
      memoryReviewIdleMs: 0,
    });
    expect(api.memory.settings('default').automaticCapture).toBe(false);
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    const before = calls.length;
    await chat('', first.requestId);
    expect(calls).toHaveLength(before);
  });
  it('corrects and forgets through authenticated APIs', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const old = api.memory.snapshot('default').facts[0];
    expect(
      (
        await request('/memory/' + old.id + '/correct', 'POST', {
          text: 'User prefers tea.',
          object: 'tea',
        })
      ).response.ok,
    ).toBe(true);
    const history = (await request<MemorySnapshot>('/memory?history=true')).data;
    expect(history.facts).toHaveLength(2);
    expect(history.facts.find((fact) => fact.id === old.id)?.validTo).not.toBeNull();
    await request('/memory', 'DELETE');
    expect(api.memory.snapshot('default').facts).toHaveLength(0);
    expect((await fetch(api.url + '/memory')).status).toBe(401);
    expect((await request('/memory?workspaceId=missing')).response.status).toBe(404);
  });
  it('answers missing and foreign memory ids with 404, never a server fault', async () => {
    const missing = randomUUID();
    expect((await request('/memory/' + missing, 'DELETE')).response.status).toBe(404);
    expect((await request('/memory/' + missing + '/episode', 'DELETE')).response.status).toBe(404);
    expect(
      (
        await request('/memory/' + missing + '/correct', 'POST', {
          text: 'Nothing to correct.',
          object: 'nothing',
        })
      ).response.status,
    ).toBe(404);
    expect((await request('/memory/' + missing + '/retry', 'POST')).response.status).toBe(404);
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const [fact] = api.memory.snapshot('default').facts;
    // A fact id is not an episode id: the call must not report a forgotten source.
    expect((await request('/memory/' + fact.id + '/episode', 'DELETE')).response.status).toBe(404);
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect((await request('/memory/' + fact.id, 'DELETE')).data).toMatchObject({
      forgotten: true,
      sourcesRemoved: 1,
    });
  });
  it('reports what an import changed and refuses intervals that end before they start', async () => {
    const fact = {
      subject: 'User',
      relation: 'prefers_editor',
      object: 'Neovim',
      text: 'User edits in Neovim.',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      state: 'confirmed' as const,
    };
    expect((await request('/memory/import', 'POST', { version: 1, facts: [fact] })).data).toEqual({
      imported: 1,
      deduplicated: 0,
      revived: 0,
    });
    expect((await request('/memory/import', 'POST', { version: 1, facts: [fact] })).data).toEqual({
      imported: 0,
      deduplicated: 1,
      revived: 0,
    });
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    // An end equal to its start is a retraction, so an export of corrected history re-imports.
    expect(
      (
        await request('/memory/import', 'POST', {
          version: 1,
          facts: [{ ...fact, validTo: fact.validFrom }],
        })
      ).response.status,
    ).toBe(200);
    const invalid = await request<{ error: string }>('/memory/import', 'POST', {
      version: 1,
      facts: [
        {
          ...fact,
          object: 'Cursor',
          text: 'User edits in Cursor.',
          validTo: '2025-12-31T00:00:00Z',
        },
      ],
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.data.error).toContain('ends before it begins');
    expect((await request<MemorySnapshot>('/memory?history=true')).data.facts).toHaveLength(2);
  });
  it('round-trips corrected history through export and import', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const original = api.memory.snapshot('default').facts[0];
    expect(
      (
        await request('/memory/' + original.id + '/correct', 'POST', {
          text: 'User prefers tea.',
          object: 'tea',
        })
      ).response.ok,
    ).toBe(true);
    const exported = (
      await request<{ version: 1; facts: MemorySnapshot['facts'] }>('/memory/export')
    ).data;
    expect(exported.facts).toHaveLength(2);
    expect(exported.facts.some((fact) => fact.validTo === fact.validFrom)).toBe(true);
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('restore','Restore',NULL,'now')",
    );
    const restored = await request<{ imported: number; deduplicated: number }>(
      '/memory/import?workspaceId=restore',
      'POST',
      { version: 1, facts: exported.facts },
    );
    expect(restored.response.status).toBe(200);
    expect(restored.data).toEqual({
      imported: 2,
      deduplicated: 0,
      revived: 0,
    });
    const history = (await request<MemorySnapshot>('/memory?workspaceId=restore&history=true'))
      .data;
    expect(history.facts).toHaveLength(2);
    expect((await request<MemorySnapshot>('/memory?workspaceId=restore')).data.facts).toHaveLength(
      1,
    );
  });
  it('recalls the only uncertain record instead of nothing and marks it unverified', async () => {
    expect(
      (
        await request('/memory/import', 'POST', {
          version: 1,
          facts: [
            {
              subject: 'Billing service',
              relation: 'uses_database',
              object: 'PostgreSQL',
              text: 'The billing service uses PostgreSQL.',
              validFrom: '2020-01-01T00:00:00Z',
              validTo: '2024-01-01T00:00:00Z',
              state: 'confirmed' as const,
            },
            {
              subject: 'Billing service',
              relation: 'uses_database',
              object: 'SQLite',
              text: 'The billing service uses SQLite.',
              validFrom: '2024-01-01T00:00:00Z',
              validTo: null,
              state: 'uncertain' as const,
            },
          ],
        })
      ).response.ok,
    ).toBe(true);
    // The confirmed record has ended, so the uncertain one is the workspace's only answer.
    const hits = await api.memory.searchWorkspace('default', 'billing service database', {});
    expect(hits.map((hit) => hit.fact.object)).toEqual(['SQLite']);
    const payload = await api.memory.contextWorkspace('default', 'billing service database', 4000);
    expect(payload.content).toContain('"state":"uncertain"');
    expect(payload.content).toContain('"evidence":["import"]');
    // A confirmed current record still wins over the uncertain one.
    expect(
      (
        await request('/memory/import', 'POST', {
          version: 1,
          facts: [
            {
              subject: 'Billing service',
              relation: 'uses_database',
              object: 'MySQL',
              text: 'The billing service uses MySQL.',
              validFrom: '2025-01-01T00:00:00Z',
              validTo: null,
              state: 'confirmed' as const,
            },
          ],
        })
      ).response.ok,
    ).toBe(true);
    expect(
      (await api.memory.searchWorkspace('default', 'billing service database', {}))[0].fact.object,
    ).toBe('MySQL');
  });
  it('restores forgotten facts on an explicit import without reviving background replay', async () => {
    const fact = {
      subject: 'User',
      relation: 'prefers_editor',
      object: 'Neovim',
      text: 'User edits in Neovim.',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      state: 'confirmed' as const,
    };
    await request('/memory/import', 'POST', { version: 1, facts: [fact] });
    const [forgotten] = api.memory.snapshot('default').facts;
    expect((await request('/memory/' + forgotten.id, 'DELETE')).response.ok).toBe(true);
    expect(api.memory.snapshot('default').facts).toHaveLength(0);
    // A forget stops automatic replay; restoring a backup is an explicit write and must apply.
    expect((await request('/memory/import', 'POST', { version: 1, facts: [fact] })).data).toEqual({
      imported: 0,
      deduplicated: 0,
      revived: 1,
    });
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect((await request('/memory/import', 'POST', { version: 1, facts: [fact] })).data).toEqual({
      imported: 0,
      deduplicated: 1,
      revived: 0,
    });
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    // Clearing the workspace then restoring a backup must not silently write nothing.
    expect((await request('/memory', 'DELETE')).response.ok).toBe(true);
    expect((await request('/memory/import', 'POST', { version: 1, facts: [fact] })).data).toEqual({
      imported: 0,
      deduplicated: 0,
      revived: 1,
    });
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
  });
  it('treats an epoch validFrom as no stated beginning and keeps a real historical date', async () => {
    await close(api.server);
    api = await startApiServer(0, {
      dataDir: dir,
      memoryReviewIdleMs: 0,
      memoryExtractor: async () => ({
        facts: [
          { ...coffee, validFrom: '1970-01-01T00:00:00Z' },
          {
            ...coffee,
            relation: 'born_in',
            object: '1968',
            text: 'User was born in May 1968.',
            validFrom: '1968-05-04T00:00:00Z',
          },
        ],
      }),
    });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(2));
    const facts = api.memory.snapshot('default').facts;
    const preference = facts.find((fact) => fact.relation === 'prefers_coffee')!;
    const birth = facts.find((fact) => fact.relation === 'born_in')!;
    expect(Number(preference.validFrom.slice(0, 4))).toBeGreaterThan(2000);
    expect(birth.validFrom).toBe('1968-05-04T00:00:00.000Z');
  });
  it('merges a claim re-learned through another channel instead of serving it twice', async () => {
    let learned: ExtractedFact[] = [];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    const learn = async (fact: ExtractedFact, sourceKey: string) => {
      learned = [fact];
      await engine.addMemory({
        workspaceId: 'default',
        sourceKey,
        sourceType: 'tool',
        content: 'Checked the gateway deployment.',
        referenceTime: '2026-01-06T00:00:00Z',
      });
    };
    // The same sentence reaches memory twice: once as a tool finding, once from the review of the
    // message. The second copy stated an earlier beginning, which used to write a second row.
    await learn(cache('2026-01-06T00:00:00Z'), 'tool-1');
    await learn(cache('2026-01-04T00:00:00Z'), 'review-1');
    const facts = api.memory.snapshot('default').facts;
    expect(facts).toHaveLength(1);
    expect(facts[0].validFrom).toBe('2026-01-04T00:00:00.000Z');
    expect(facts[0].sources.map((source) => source.sourceKey).sort()).toEqual([
      'review-1',
      'tool-1',
    ]);
  });
  it('keeps one row when the same sentence arrives hedged and plain', async () => {
    let learned: ExtractedFact[] = [];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    const learn = async (fact: ExtractedFact, sourceKey: string) => {
      learned = [fact];
      await engine.addMemory({
        workspaceId: 'default',
        sourceKey,
        sourceType: 'tool',
        content: 'Checked the gateway deployment.',
        referenceTime: '2026-01-06T00:00:00Z',
      });
    };
    await learn(cache('2026-01-06T00:00:00Z', 'uncertain'), 'review-1');
    expect(api.memory.snapshot('default').facts.map((fact) => fact.state)).toEqual(['uncertain']);
    // A plain statement of the same sentence settles the hedge instead of adding a second answer.
    await learn(cache('2026-01-06T00:00:00Z'), 'tool-1');
    const merged = api.memory.snapshot('default').facts;
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe('confirmed');
    expect(merged[0].sources).toHaveLength(2);
    // A later hedge must not demote what a plain statement already settled.
    await learn(cache('2026-01-06T00:00:00Z', 'uncertain'), 'review-2');
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect(api.memory.snapshot('default').facts[0].state).toBe('confirmed');
  });
  it('does not duplicate a claim when a replacement cannot see the fact it replaces', async () => {
    let learned: ExtractedFact[] = [];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    const learn = async (
      fact: ExtractedFact,
      sourceKey: string,
      content = 'Checked the gateway.',
    ) => {
      learned = [fact];
      await engine.addMemory({
        workspaceId: 'default',
        sourceKey,
        sourceType: 'tool',
        content,
        referenceTime: '2026-01-06T00:00:00Z',
      });
    };
    await learn(cache('2026-01-06T00:00:00Z'), 'tool-1');
    // A replacement that names a fact the extractor was never shown used to be stored as a second
    // copy of the claim it meant to replace, hedged as uncertain.
    await learn(cache('2026-01-06T00:00:00Z', 'replace', ['deleted-before-extraction']), 'tool-2');
    const facts = api.memory.snapshot('default').facts;
    expect(facts).toHaveLength(1);
    expect(facts[0].state).toBe('confirmed');
    expect(facts[0].supersededBy).toBeNull();
    expect(facts[0].sources).toHaveLength(2);
  });
  it('replaces a fact the model names even when it was outside the candidate window', async () => {
    const filler = (index: number): ExtractedFact => ({
      ...coffee,
      subject: `Alpha service ${index}`,
      relation: 'alpha_role',
      object: `alpha-role-${index}`,
      text: `Alpha service ${index} handles alpha traffic.`,
      validFrom: '2026-01-01T00:00:00Z',
    });
    let learned: ExtractedFact[] = Array.from({ length: 24 }, (_, index) => filler(index));
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    // An extraction can carry at most 24 facts, so crowd the workspace out in three passes.
    for (const batch of [0, 1, 2]) {
      const offset = batch * 24;
      learned = Array.from({ length: 24 }, (_, index) => filler(offset + index));
      await engine.addMemory({
        workspaceId: 'default',
        sourceKey: `bulk-${batch}`,
        sourceType: 'tool',
        content: 'Alpha inventory sweep.',
        referenceTime: '2026-01-01T00:00:00Z',
      });
    }
    learned = [cache('2026-01-06T00:00:00Z')];
    await engine.addMemory({
      workspaceId: 'default',
      sourceKey: 'tool-1',
      sourceType: 'tool',
      content: 'Checked the gateway deployment.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    const [original] = api.memory
      .snapshot('default')
      .facts.filter((fact) => fact.relation === 'runs_cache');
    expect(original).toBeDefined();
    // The correction cites the stored fact from the recall trace. Only the 60 best-matching facts are
    // handed to the extractor, and these Alpha records crowd it out of that window.
    learned = [
      cache('2026-02-01T00:00:00Z', 'replace', [original.id], {
        object: 'valkey',
        text: 'The gateway runs on Valkey.',
      }),
    ];
    await engine.addMemory({
      workspaceId: 'default',
      sourceKey: 'tool-2',
      sourceType: 'tool',
      content: 'Alpha sweep across the workspace.',
      referenceTime: '2026-02-01T00:00:00Z',
    });
    const history = (await request<MemorySnapshot>('/memory?history=true')).data.facts;
    const replacement = history.find((fact) => fact.object === 'valkey')!;
    expect(replacement.state).toBe('confirmed');
    const replaced = history.find((fact) => fact.id === original.id)!;
    expect(replaced.validTo).toBe('2026-02-01T00:00:00.000Z');
    expect(replaced.supersededBy).toBe(replacement.id);
    expect(
      api.memory
        .snapshot('default')
        .facts.filter((fact) => fact.subject === 'Gateway')
        .map((fact) => fact.object),
    ).toEqual(['valkey']);
  });
  it('retries a capture the model dropped instead of losing the exchange', async () => {
    // One unavailable model used to discard the exchange for good; 38 of them were waiting that way.
    await close(api.server);
    api = await startApiServer(0, {
      dataDir: dir,
      memoryReviewIdleMs: 600000,
      memoryExtractor: async () => {
        throw new Error('provider unavailable');
      },
    });
    const episode = api.memory.engine.enqueue({
      workspaceId: 'default',
      sourceKey: 'dropped-1',
      sourceType: 'tool',
      content: 'I prefer espresso every morning.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    await api.memory.engine.processEpisode(episode.id).catch(() => {});
    const failed = api.store.get("SELECT * FROM memory_episodes WHERE source_key='dropped-1'");
    expect(failed?.status).toBe('failed');
    expect(Number(failed?.attempts)).toBe(1);
    expect(Number(failed?.retry_at)).toBeGreaterThan(Date.now());
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryReviewIdleMs: 600000 });
    // The backoff has elapsed, so the queue takes the dropped exchange back on its own.
    api.store.run(
      "UPDATE memory_episodes SET retry_at=? WHERE source_key='dropped-1'",
      Date.now() - 1,
    );
    await chat('Anything on the garden beds?');
    await vi.waitFor(
      () =>
        expect(api.memory.snapshot('default').facts.map((fact) => fact.text)).toContain(
          'User prefers espresso every morning.',
        ),
      { timeout: 8000 },
    );
    expect(
      api.store.get("SELECT status FROM memory_episodes WHERE source_key='dropped-1'")?.status,
    ).toBe('complete');
  });
  it('stops retrying a capture once the bounded attempts run out', async () => {
    const engine = new MemoryEngine(api.memory.store, async () => {
      throw new Error('provider unavailable');
    });
    const episode = engine.enqueue({
      workspaceId: 'default',
      sourceKey: 'dropped-2',
      sourceType: 'tool',
      content: 'The gateway uses Redis.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    for (let attempt = 0; attempt < CAPTURE_ATTEMPT_LIMIT + 1; attempt++)
      await engine.processEpisode(episode.id).catch(() => {});
    const row = api.store.get("SELECT * FROM memory_episodes WHERE source_key='dropped-2'");
    expect(row?.status).toBe('failed');
    expect(Number(row?.attempts)).toBeGreaterThanOrEqual(CAPTURE_ATTEMPT_LIMIT);
    expect(row?.retry_at).toBeNull();
    // A spent source waits for the user rather than queueing forever.
    expect(
      api.store.get(
        "SELECT id FROM memory_episodes WHERE status='failed' AND attempts>0 AND attempts<? AND (retry_at IS NULL OR retry_at<=?) AND source_key='dropped-2'",
        CAPTURE_ATTEMPT_LIMIT,
        Date.now() + 86400000,
      ),
    ).toBeUndefined();
    expect(api.memory.snapshot('default').facts).toHaveLength(0);
  });
  it('retries a failed review on a backoff instead of blocking the conversation', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('A project finding worth remembering.');
    let failing = true;
    const engine = new MemoryEngine(api.memory.store, async () => {
      if (failing) throw new Error('provider unavailable');
      return { facts: [coffee] };
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')[0].status).toBe('failed');
    const queued = api.store.get(
      "SELECT * FROM memory_review_jobs WHERE conversation_id='bot-scout'",
    );
    // It used to be blocked until the user noticed it in Settings.
    expect(Number(queued?.blocked)).toBe(0);
    expect(Number(queued?.due_at)).toBeGreaterThan(Date.now());
    failing = false;
    api.store.run(
      "UPDATE memory_review_jobs SET due_at=? WHERE conversation_id='bot-scout'",
      Date.now() - 1,
    );
    await worker.drain(new AbortController().signal);
    expect(worker.list('default')[0].status).toBe('complete');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
  });
  it('blocks a conversation whose reviews keep failing', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('A project finding worth remembering.');
    const engine = new MemoryEngine(api.memory.store, async () => {
      throw new Error('provider unavailable');
    });
    const worker = new MemoryReviewService(
      api.memory.store,
      engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    for (let attempt = 0; attempt < CAPTURE_ATTEMPT_LIMIT; attempt++) {
      api.store.run(
        "UPDATE memory_review_jobs SET due_at=? WHERE conversation_id='bot-scout'",
        Date.now() - 1,
      );
      await worker.drain(new AbortController().signal);
    }
    expect(
      Number(
        api.store.get("SELECT blocked FROM memory_review_jobs WHERE conversation_id='bot-scout'")
          ?.blocked,
      ),
    ).toBe(1);
    // The user can still see it and retry deliberately.
    expect(worker.list('default').filter((run) => run.status === 'failed')).toHaveLength(
      CAPTURE_ATTEMPT_LIMIT,
    );
  });
  it('closes a review attempt that a later review already covers', async () => {
    api.memory.saveSettings('default', {
      ...api.memory.settings('default'),
      automaticCapture: false,
    });
    await chat('A project finding worth remembering.');
    api.store.run(
      `INSERT INTO memory_episodes(id,workspace_id,source_key,source_type,content,reference_time,
        conversation_id,context,created_at,status,attempts)
       VALUES('orphan-1','default','review:bot-scout:0:1','user','stuck attempt','2026-01-01T00:00:00Z',
        'bot-scout','','2026-01-01T00:00:00Z','pending',1)`,
    );
    const worker = new MemoryReviewService(
      api.memory.store,
      api.memory.engine,
      new BotRepository(api.store),
      () => true,
      0,
    );
    worker.schedule('default', 'bot-scout', 'scout');
    await worker.drain(new AbortController().signal);
    // The new pass read everything from the same checkpoint, so the abandoned one is finished with.
    expect(api.store.get("SELECT status FROM memory_episodes WHERE id='orphan-1'")?.status).toBe(
      'complete',
    );
  });
  it('folds duplicate claims written before the overlap guard, and only when asked', async () => {
    const learned: ExtractedFact[] = [cache('2026-01-06T00:00:00Z')];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    await engine.addMemory({
      workspaceId: 'default',
      sourceKey: 'tool-1',
      sourceType: 'tool',
      content: 'Checked the gateway deployment.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    const [original] = api.memory.snapshot('default').facts;
    const originalSource = String(
      api.memory.store.get(
        'SELECT episode_id FROM memory_fact_sources WHERE fact_id=? LIMIT 1',
        original.id,
      )?.episode_id,
    );
    const { twin, source } = plantTwin(original.id, {
      validFrom: '2026-01-04T00:00:00.000Z',
      state: 'uncertain',
    });
    // A legacy chain that names the copy about to go: the older era says the twin replaced it.
    const era = randomUUID();
    api.memory.store.run(
      `INSERT INTO memory_facts(id,workspace_id,owner_id,subject_id,relation,object_id,text,valid_from,
        valid_to,created_at,superseded_by,state,vector_json,vector_model)
       SELECT ?,workspace_id,owner_id,subject_id,relation,object_id,text,'2025-01-01T00:00:00.000Z',
        '2026-01-04T00:00:00.000Z',?,?,'confirmed',NULL,NULL FROM memory_facts WHERE id=?`,
      era,
      new Date().toISOString(),
      twin,
      original.id,
    );
    const served = () =>
      api.memory.snapshot('default').facts.filter((f) => f.text === original.text);
    const history = () =>
      api.memory
        .snapshot('default', '', true)
        .facts.filter((fact) => fact.subject === original.subject);
    expect(served()).toHaveLength(2);

    // Reporting must not be allowed to remove anything: this is the one memory write that deletes rows.
    const preview = engine.consolidateClaims({ workspaceId: 'default', includePrivate: true });
    expect(preview).toMatchObject({ applied: false, groups: 1, removed: 1, sourcesMoved: 1 });
    expect(served()).toHaveLength(2);

    const report = engine.consolidateClaims({ workspaceId: 'default', includePrivate: true }, true);
    expect(report).toMatchObject({ applied: true, groups: 1, removed: 1, sourcesMoved: 1 });
    const [kept] = served();
    expect(kept.id).toBe(original.id);
    // The earliest start and the stronger of the two states survive, with both sources.
    expect(kept.validFrom).toBe('2026-01-04T00:00:00.000Z');
    expect(kept.state).toBe('confirmed');
    expect(kept.sources).toHaveLength(2);
    // Lineage follows the survivor instead of dangling at a removed id, and its index entry goes.
    expect(history().find((fact) => fact.id === era)?.supersededBy).toBe(original.id);
    expect(
      api.memory.store.get('SELECT fact_id FROM memory_fts WHERE fact_id=?', twin),
    ).toBeUndefined();
    expect(history()).toHaveLength(2);
    // Nothing was forgotten: the retired row's own source keeps its content and is now cited.
    expect(kept.sources.map((entry) => entry.id).sort()).toEqual([originalSource, source].sort());
    expect(api.store.get('SELECT content FROM memory_episodes WHERE id=?', source)?.content).toBe(
      'Checked the gateway deployment.',
    );
    expect(
      engine.consolidateClaims({ workspaceId: 'default', includePrivate: true }, true),
    ).toMatchObject({ groups: 0, removed: 0 });
  });
  it('leaves an ended era out of the consolidation', async () => {
    const learned: ExtractedFact[] = [cache('2026-01-06T00:00:00Z')];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    await engine.addMemory({
      workspaceId: 'default',
      sourceKey: 'tool-1',
      sourceType: 'tool',
      content: 'Checked the gateway deployment.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    const [original] = api.memory.snapshot('default').facts;
    plantTwin(original.id, { validTo: '2026-01-05T00:00:00.000Z' });
    // Same sentence, one span closed and one open: two eras of one claim, not a duplicate.
    expect(
      engine.consolidateClaims({ workspaceId: 'default', includePrivate: true }, true),
    ).toMatchObject({ groups: 0, removed: 0 });
    expect(api.memory.snapshot('default', '', true).facts).toHaveLength(2);
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
  });
  it('exposes the consolidation as a maintenance endpoint that reports before it applies', async () => {
    const learned: ExtractedFact[] = [cache('2026-01-06T00:00:00Z')];
    const engine = new MemoryEngine(api.memory.store, async () => ({ facts: learned }));
    await engine.addMemory({
      workspaceId: 'default',
      sourceKey: 'tool-1',
      sourceType: 'tool',
      content: 'Checked the gateway deployment.',
      referenceTime: '2026-01-06T00:00:00Z',
    });
    plantTwin(api.memory.snapshot('default').facts[0]!.id);
    // A call with no body is refused rather than treated as "apply", so a stray request cannot cut rows.
    expect((await request('/memory/consolidate', 'POST')).response.status).toBe(400);
    const preview = await request<{ applied: boolean; groups: number; removed: number }>(
      '/memory/consolidate',
      'POST',
      {},
    );
    expect(preview.data).toMatchObject({ applied: false, groups: 1, removed: 1 });
    expect(api.memory.snapshot('default').facts).toHaveLength(2);
    const applied = await request<{ applied: boolean; groups: number; removed: number }>(
      '/memory/consolidate',
      'POST',
      { apply: true },
    );
    expect(applied.data).toMatchObject({ applied: true, groups: 1, removed: 1 });
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect(
      (
        await request<{ groups: number; removed: number }>('/memory/consolidate', 'POST', {
          apply: true,
        })
      ).data,
    ).toMatchObject({ groups: 0, removed: 0 });
  });
  it('embeds imported facts in the background so restored memory stays semantic', async () => {
    api.memory.embedding.ready = true;
    const embed = vi
      .spyOn(api.memory.embedding, 'embed')
      .mockImplementation(async (texts) => texts.map(() => [1, ...Array<number>(383).fill(0)]));
    api.memory.saveSettings('default', { ...api.memory.settings('default'), semanticSearch: true });
    expect(
      (
        await request('/memory/import', 'POST', {
          version: 1,
          facts: [
            {
              subject: 'User',
              relation: 'prefers_editor',
              object: 'Neovim',
              text: 'User edits in Neovim.',
              validFrom: '2026-01-01T00:00:00Z',
              validTo: null,
              state: 'confirmed' as const,
            },
          ],
        })
      ).response.ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        api.memory.store.get('SELECT vector_json FROM memory_facts LIMIT 1')?.vector_json,
      ).toBeTruthy(),
    );
    expect(embed.mock.calls.some((call) => call[1] === 'document')).toBe(true);
  });
  it('rejects invalid settings and private import owners, and imports without model calls', async () => {
    expect(
      (
        await request('/memory/settings', 'PUT', {
          ...api.memory.settings('default'),
          contextTokens: 99999,
        })
      ).response.status,
    ).toBe(400);
    const imported = {
      subject: 'Mukai',
      relation: 'uses_database',
      object: 'SQLite',
      text: 'Mukai uses SQLite.',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      state: 'confirmed',
    };
    const before = calls.length;
    expect(
      (await request('/memory/import', 'POST', { version: 1, facts: [imported] })).response.ok,
    ).toBe(true);
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    expect(calls).toHaveLength(before);
    expect(
      (
        await request('/memory/import', 'POST', {
          version: 1,
          facts: [{ ...imported, ownerId: 'unknown-bot' }],
        })
      ).response.status,
    ).toBe(400);
  });
  it('uses the configured provider for validated extraction and preserves schema failures for retry', async () => {
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryReviewIdleMs: 0 });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const extractionCall = calls.find((call) => !call.stream)!;
    expect(extractionCall.response_format).toBeUndefined();
    expect(extractionCall.enable_thinking).toBe(false);
    expect(extractionCall.thinking).toEqual({ type: 'disabled' });
    expect(JSON.stringify(extractionCall.messages[0])).toContain('untrusted data');
    const system = String(extractionCall.messages[0].content);
    const schema = JSON.parse(
      system.split(
        'Required output JSON schema (include every required field, using null or empty arrays where appropriate):\n',
      )[1],
    );
    expect(schema.required).toEqual(expect.arrayContaining(['facts', 'reviewSummary']));
    expect(schema.properties.facts.items.required).toEqual(
      expect.arrayContaining(['subjectId', 'objectId', 'subjectType', 'validFrom', 'supersedes']),
    );
    invalidSchema = true;
    await chat('Remember this new preference.');
    await vi.waitFor(() =>
      expect(
        api.memory.snapshot('default').episodes.some((episode) => episode.status === 'failed'),
      ).toBe(true),
    );
    expect(api.memory.snapshot('default').facts).toHaveLength(1);
    const failed = api.memory
      .snapshot('default')
      .episodes.find((episode) => episode.status === 'failed')!;
    const diagnostic = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'memory.extraction_failed');
    expect(diagnostic).toMatchObject({
      providerKind: 'compatible',
      phase: 'memory-extraction',
      error: { generatedTextBytes: 8 },
    });
    expect(JSON.stringify(diagnostic)).not.toContain('Remember this new preference.');
    expect(calls.filter((call) => !call.stream)).toHaveLength(3);
    invalidSchema = false;
    await request('/memory/' + failed.id + '/retry', 'POST', {});
    await vi.waitFor(() =>
      expect(
        api.memory.snapshot('default').episodes.find((episode) => episode.id === failed.id)?.status,
      ).toBe('complete'),
    );
  });
  it('regenerates once when a compatible provider returns valid JSON with missing required fields', async () => {
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryReviewIdleMs: 0 });
    extractionResponses.push({
      content: JSON.stringify({ facts: [{ text: 'PRIVATE INVALID FACT' }] }),
      finishReason: 'stop',
    });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const requests = calls.filter((call) => !call.stream);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain('previous attempt');
    expect(JSON.stringify(requests[1].messages)).not.toContain('PRIVATE INVALID FACT');
    const log = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(log).toContain('memory.extraction_retry');
    expect(log).not.toContain('PRIVATE INVALID FACT');
    expect(log).not.toContain('memory.extraction_failed');
  });
  it('recovers an empty token-limited response with a larger bounded budget and logs metadata', async () => {
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryReviewIdleMs: 0 });
    extractionResponses.push({ content: null, finishReason: 'length' });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const requests = calls.filter((call) => !call.stream);
    expect(requests).toHaveLength(2);
    expect(requests[0].max_tokens).toBe(12000);
    // The retry stays within the configured model's context/output allowance.
    expect(requests[1].max_tokens).toBe(24000);
    expect(requests[1].max_tokens).toBeLessThanOrEqual(48000);
    const diagnostic = JSON.parse(readFileSync(join(dir, 'logs', 'errors.log'), 'utf8').trim());
    expect(diagnostic).toMatchObject({
      event: 'memory.extraction_retry',
      finishReason: 'length',
      generatedTextBytes: 0,
      outputTokens: 10,
    });
  });
  it('gives the repair a fresh deadline after the first extraction times out', async () => {
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryReviewIdleMs: 0 });
    const firstAttempt = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    let attempts = 0;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      if (milliseconds === 120000 && attempts++ === 0) return firstAttempt.signal;
      return nativeTimeout(milliseconds);
    });
    extractionResponses.push({
      content: null,
      finishReason: 'stop',
      abort: () => firstAttempt.abort(new DOMException('Request timed out', 'TimeoutError')),
    });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    expect(calls.filter((call) => !call.stream)).toHaveLength(2);
    expect(firstAttempt.signal.aborted).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(2);
    const log = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(log).toContain('memory.extraction_retry');
    expect(log).not.toContain('memory.extraction_failed');
  });
});
