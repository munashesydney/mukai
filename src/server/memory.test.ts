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
import { memoryTools } from './tools/memory/execute';
import { memoryDefinition } from './tools/memory/definition';

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
  tools?: { function: { name: string } }[];
}[];
let invalidSchema = false;
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
    } else
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
                content: invalidSchema ? 'not json' : JSON.stringify({ facts: [coffee] }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: extractor });
  seedTestBot(api.store);
  await request('/providers', 'POST', {
    name: 'Memory fixture',
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
    defaultModel: 'test-memory',
    supportsImages: false,
    isDefault: true,
    apiKey: '',
  });
});
afterEach(async () => {
  await close(api.server);
  await close(fixture);
  expect(dir.startsWith(join(tmpdir(), 'mukai-memory-test-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('Mukai memory integration', () => {
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
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: extractor });
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
    api = await startApiServer(0, { dataDir: dir });
    await chat('I prefer espresso every morning.');
    await vi.waitFor(() => expect(api.memory.snapshot('default').facts).toHaveLength(1));
    const extractionCall = calls.find((call) => !call.stream)!;
    expect(extractionCall.response_format).toBeDefined();
    expect(JSON.stringify(extractionCall.messages[0])).toContain('untrusted data');
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
    invalidSchema = false;
    await request('/memory/' + failed.id + '/retry', 'POST', {});
    await vi.waitFor(() =>
      expect(
        api.memory.snapshot('default').episodes.find((episode) => episode.id === failed.id)?.status,
      ).toBe('complete'),
    );
  });
});
