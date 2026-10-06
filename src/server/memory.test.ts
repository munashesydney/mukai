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
import { MemoryEngine } from '../../mukai_memory/src';
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
let dir: string, api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server;
let calls: {
  messages: { role: string; content: unknown }[];
  stream?: boolean;
  response_format?: unknown;
  max_tokens?: number;
  tools?: { function: { name: string } }[];
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
    expect(run).toMatchObject({ status: 'complete', ownerId: 'scout', kind: 'private' });
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
    const add = vi.spyOn(api.memory, 'add').mockResolvedValue([]);
    const forget = vi.spyOn(api.memory.engine, 'forgetMemory').mockImplementation(() => {});
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
    for (const scope of ['private', 'workspace'] as const) {
      expect(
        await invoke({ action: 'add', content: 'User prefers espresso.', scope }),
      ).toMatchObject({ ok: true });
      expect(add.mock.calls.at(-1)?.[4]).toBe(scope === 'workspace');
    }
    const asOf = '2026-02-15T12:00:00Z';
    expect(
      await invoke({ action: 'search', query: 'espresso', limit: 7, asOf, includeHistory: true }),
    ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledWith(bot, 'bot-scout', 'espresso', {
      limit: 7,
      asOf,
      includeHistory: true,
    });
    const memoryId = randomUUID();
    expect(await invoke({ action: 'forget', memoryId })).toMatchObject({
      ok: true,
      result: { forgotten: true },
    });
    expect(forget).toHaveBeenCalledWith(api.memory.scope(bot, 'bot-scout'), memoryId);
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
    const add = vi.spyOn(api.memory, 'add').mockResolvedValue([]);
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
        { action: 'add', content: 'MEMTEST-03 private investigation result.', scope: 'private' },
        { toolCallId: 'write-after-searches', messages: [], context: {} },
      ),
    ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(13);
    expect(add).toHaveBeenCalledOnce();
  });
  it('captures private facts, automatically recalls them, and records actual supplied facts', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    expect(api.memory.snapshot('default').facts[0].ownerId).toBe('scout');
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
    expect(JSON.stringify(latest.tools)).toContain('add requires content and scope');
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
  it('does not inject private memories into shared spaces or another workspace', async () => {
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const bot = (await request<Bot[]>('/bots')).data[0];
    expect(await api.memory.search(bot, 'shared-space', 'espresso', {})).toHaveLength(0);
    api.store.run("INSERT INTO workspaces VALUES('other','Other',NULL,'now')");
    const snapshot = (await request<MemorySnapshot>('/memory?workspaceId=other')).data;
    expect(snapshot.facts).toHaveLength(0);
    expect(snapshot.recalls).toHaveLength(0);
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
    expect(extractionCall.response_format).toBeDefined();
    expect(JSON.stringify(extractionCall.messages[0])).toContain('untrusted data');
    expect(extractionCall.response_format).toEqual({ type: 'json_object' });
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
    expect(requests[1].max_tokens).toBe(16000);
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
