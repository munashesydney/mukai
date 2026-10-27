import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { seedTestWorkspace } from './testFixtures';
import type { Bot, BotInput, ChatMessage, ProviderSettings } from '../shared/ai';
import { executeBotManagement } from './tools/bots/execute';
import { WebSearchService } from './services/webSearchService';
import type { ToolInfo } from '../shared/ai';
import type { Conversation } from '../shared/conversations';
import { botManagementDefinition } from './tools/bots/definition';
import { botAvatarIds } from '../shared/mascots';
import type { ApprovalState } from '../shared/approvals';

let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, root: string;
let calls: {
  model: string;
  stream?: boolean;
  tools: {
    function: { name: string; parameters: { properties: { action?: { enum?: string[] } } } };
  }[];
  messages: { role: string; content: string; tool_call_id?: string }[];
}[];
let requestPaths: string[];
let mode:
  | 'normal'
  | 'slow'
  | 'revoke'
  | 'delegate'
  | 'delegate-slow'
  | 'delegate-approval'
  | 'delegate-tool-approval'
  | 'delegate-nested'
  | 'delegate-pursuit'
  | 'delegate-empty-once'
  | 'delegate-empty-always'
  | 'delegate-empty-restart'
  | 'web-search'
  | 'web-revoke'
  | 'probe-fail'
  | 'probe-slow';
let delegatedId: string;
let sendMode: 'fire_and_forget' | 'wait';
let nestedId: string;
let invalidAskFirst: boolean;
const waitFor = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 5000 });
const input = (name = 'Mukai'): BotInput => ({
  name,
  role: 'Assistant',
  instructions: 'Help with the task.',
  providerId: null,
  model: null,
  supportsImages: null,
  avatar: 'nova',
});
async function request<T>(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, data: (await response.json()) as T };
}
async function bot(name = 'Mukai', workspaceId = 'default') {
  const result = await request<Bot>('/bots', 'POST', { ...input(name), workspaceId });
  expect(result.status).toBe(201);
  return result.data;
}
async function provider() {
  await request('/providers', 'POST', {
    name: 'Local fixture',
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
    defaultModel: 'test',
    supportsImages: false,
    isDefault: true,
    apiKey: '',
  });
}
async function modelProvider(name: string, path: string, isDefault = true) {
  const saved = await request<ProviderSettings>('/providers', 'POST', {
    name,
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}${path}/v1`,
    defaultModel: 'text-default',
    supportsImages: false,
    isDefault,
    apiKey: 'catalog-test-secret',
    models: [
      {
        id: 'text-default',
        name: 'Text',
        contextWindowTokens: 64000,
        maxOutputTokens: 4096,
        supportsImages: false,
      },
      {
        id: 'media-model',
        name: 'Media',
        contextWindowTokens: 512000,
        maxOutputTokens: 48000,
        supportsImages: true,
        supportsAudio: true,
        supportsVideo: true,
        reasoningEffort: 'provider-default',
      },
    ],
  });
  expect(saved.status).toBe(201);
  return saved.data;
}
async function chat(target: Bot) {
  const response = await fetch(api.url + `/bots/${target.id}/chat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), text: 'Do the work', attachmentIds: [] }),
  });
  expect(response.status).toBe(200);
  await response.text();
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mukai-bot-architecture-'));
  calls = [];
  requestPaths = [];
  mode = 'normal';
  delegatedId = '';
  sendMode = 'wait';
  nestedId = '';
  invalidAskFirst = false;
  api = await startApiServer(0, {
    dataDir: join(root, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestWorkspace(api.store);
  fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as (typeof calls)[number];
    calls.push(call);
    requestPaths.push(req.url || '');
    if (!call.stream) {
      if (mode === 'probe-slow') return;
      if (mode === 'probe-fail') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: { message: 'Invalid test API key', type: 'authentication_error' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'probe',
          object: 'chat.completion',
          created: 1,
          model: call.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      );
      return;
    }
    const child = call.messages.some((item) =>
      item.content?.includes('This message is coming from another bot'),
    );
    const recoveringReply = call.messages
      .at(-1)
      ?.content?.startsWith('[Mukai runtime continuation');
    if (mode === 'slow' || (mode === 'delegate-slow' && child)) return;
    if (child && mode === 'delegate-empty-restart' && recoveringReply) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (child && invalidAskFirst) {
      invalidAskFirst = false;
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'invalid-ask',
            type: 'function',
            function: {
              name: 'communicate',
              arguments: JSON.stringify({ question: 'PRIVATE INVALID QUESTION' }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else if (
      child &&
      [
        'delegate-approval',
        'delegate-tool-approval',
        'delegate-nested',
        'delegate-pursuit',
        'delegate-empty-once',
        'delegate-empty-always',
        'delegate-empty-restart',
      ].includes(mode) &&
      !call.messages.some((item) => item.tool_call_id === 'child-call')
    ) {
      const intermediate =
        mode === 'delegate-nested' &&
        call.messages.some(
          (item) =>
            item.content?.includes('"name":"Mukai"') &&
            item.content.includes('This message is coming from another bot'),
        );
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'child-call',
            type: 'function',
            function: {
              name: intermediate
                ? 'manage_bot'
                : mode === 'delegate-tool-approval'
                  ? 'browser'
                  : 'communicate',
              arguments: JSON.stringify(
                intermediate
                  ? {
                      action: 'send_message',
                      botId: nestedId,
                      message: 'Check the details.',
                      mode: 'wait',
                    }
                  : mode === 'delegate-tool-approval'
                    ? { action: 'tabs' }
                    : mode.startsWith('delegate-empty-')
                      ? {
                          action: 'clarification',
                          question: 'What’s one small thing you’re looking forward to this week?',
                          options: [
                            { label: 'A meal or treat', recommended: true },
                            { label: 'A quiet moment', recommended: false },
                          ],
                        }
                      : { action: 'approval', question: 'May I publish this draft?' },
              ),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else if (child && mode.startsWith('delegate-empty-')) {
      if (mode === 'delegate-empty-always' || !recoveringReply) send({}, 'stop');
      else {
        send({ role: 'assistant', content: 'The user chose: A meal or treat.' });
        send({}, 'stop');
      }
    } else if (
      mode === 'delegate-pursuit' &&
      !child &&
      call.messages.some((item) => item.role === 'tool') &&
      !call.messages.some((item) => item.tool_call_id === 'pursuit-report')
    ) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'pursuit-report',
            type: 'function',
            function: {
              name: 'report_pursuit',
              arguments: JSON.stringify({
                status: 'completed',
                summary: 'Child review finished.',
                nextRunAt: null,
                nextRunReason: null,
                nextRunInstructions: null,
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else if (
      ['web-search', 'web-revoke'].includes(mode) &&
      !call.messages.some((item) => item.role === 'tool')
    ) {
      if (mode === 'web-revoke') {
        const main = (await request<Bot[]>('/bots')).data.find((item) => item.isMain)!;
        api.access.set('default', main.id, 'web_search', false);
      }
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'web-search-call',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ action: 'search', query: 'official docs' }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else if (mode === 'revoke' && !call.messages.some((item) => item.role === 'tool')) {
      const main = (await request<Bot[]>('/bots')).data.find((item) => item.isMain)!;
      api.access.set('default', main.id, 'browser', false);
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'revoke-call',
            type: 'function',
            function: { name: 'browser', arguments: '{"action":"tabs"}' },
          },
        ],
      });
      send({}, 'tool_calls');
    } else if (
      mode.startsWith('delegate') &&
      !call.messages.some((item) => item.role === 'tool') &&
      !call.messages.some((item) =>
        item.content?.includes('This message is coming from another bot'),
      )
    ) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'send-message-call',
            type: 'function',
            function: {
              name: 'manage_bot',
              arguments: JSON.stringify({
                action: 'send_message',
                botId: delegatedId,
                message: 'Review the notes.',
                mode: sendMode,
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'Reviewed the notes successfully.' });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  api.server.closeAllConnections();
  fixture.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => api.server.close(() => resolve())),
    new Promise<void>((resolve) => fixture.close(() => resolve())),
  ]);
  expect(root.startsWith(join(tmpdir(), 'mukai-bot-architecture-'))).toBe(true);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
describe('Bot architecture', () => {
  it('gives only the main bot deletion access and preserves hierarchy and workspace boundaries', async () => {
    const main = await bot(),
      child = await bot('Ada'),
      peer = await bot('Nova');
    const context = (caller: Bot) => ({
      bot: caller,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    });
    expect(api.botManagement.actionsFor(main)).toContain('delete');
    expect(api.botManagement.actionsFor(child)).not.toContain('delete');
    expect(
      await executeBotManagement(
        { action: 'delete', botId: peer.id },
        context(child),
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Only the workspace main bot') });
    expect(
      await executeBotManagement({ action: 'delete', botId: main.id }, context(main), randomUUID()),
    ).toMatchObject({ ok: false, error: expect.stringContaining('cannot delete itself') });
    api.store.run('UPDATE bots SET created_by=? WHERE id=?', child.id, peer.id);
    expect(
      await executeBotManagement(
        { action: 'delete', botId: child.id },
        context(main),
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('child bots first') });
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other-delete','Other',NULL,'now')",
    );
    api.store.run('UPDATE bots SET workspace_id=? WHERE id=?', 'other-delete', peer.id);
    expect(
      await executeBotManagement({ action: 'delete', botId: peer.id }, context(main), randomUUID()),
    ).toMatchObject({ ok: false, error: expect.stringContaining('another workspace') });
    api.store.run(
      'UPDATE bots SET workspace_id=?,created_by=? WHERE id=?',
      'default',
      main.id,
      peer.id,
    );
    const removed = await executeBotManagement(
      { action: 'delete', botId: child.id },
      context(main),
      randomUUID(),
    );
    expect(removed).toMatchObject({ ok: true, result: { deleted: true, botId: child.id } });
    expect((await request<Bot[]>('/bots')).data.map((item) => item.id)).toEqual(
      expect.arrayContaining([main.id, peer.id]),
    );
    expect((await request<Bot[]>('/bots')).data.map((item) => item.id)).not.toContain(child.id);
  });
  it('refuses to delete a bot while its response is active', async () => {
    const main = await bot(),
      child = await bot('Ada');
    await provider();
    mode = 'slow';
    const running = chat(child);
    await waitFor(async () =>
      expect(
        (await request<ChatMessage[]>(`/bots/${child.id}/messages`)).data.some(
          (item) => item.status === 'streaming',
        ),
      ).toBe(true),
    );
    const result = await executeBotManagement(
      { action: 'delete', botId: child.id },
      {
        bot: main,
        management: api.botManagement,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Stop this bot') });
    await request(`/bots/${child.id}/stop`, 'POST');
    await running;
  });

  it('assigns unused random mascots to AI-created bots without exposing mascots to the AI', async () => {
    const mascots = botAvatarIds.filter((avatar) => avatar !== 'mukai-logo');
    const main = (await request<Bot>('/bots', 'POST', { ...input(), avatar: mascots[0] })).data;
    await provider();
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const create = async (name: string) => {
      const result = await executeBotManagement(
        botManagementDefinition.inputSchema.parse({
          action: 'create',
          name,
          role: 'Researcher',
          instructions: 'Help with research.',
          avatar: 'mukai-logo',
        }),
        context,
        randomUUID(),
      );
      expect(result.ok).toBe(true);
      expect(result.result).not.toHaveProperty('avatar');
      return result.result as Omit<Bot, 'avatar'>;
    };
    expect(botManagementDefinition.description).not.toMatch(/avatar|mascot/);
    expect(
      botManagementDefinition.inputSchema.parse({ action: 'create', avatar: 'mukai-logo' }),
    ).not.toHaveProperty('avatar');
    const children = await Promise.all(
      mascots.slice(1).map((_, index) => create(`Helper ${index}`)),
    );
    const assigned = (await request<Bot[]>('/bots')).data.map((bot) => bot.avatar);
    expect(new Set(assigned).size).toBe(mascots.length);
    expect(assigned.sort()).toEqual([...mascots].sort());
    const overflow = await create('Extra helper');
    const saved = (await request<Bot[]>('/bots')).data.find((bot) => bot.id === overflow.id)!;
    expect(mascots).toContain(saved.avatar);
    const inspected = await executeBotManagement(
      { action: 'get', botId: saved.id },
      context,
      randomUUID(),
    );
    expect(inspected.result).not.toHaveProperty('avatar');
    const changed = await executeBotManagement(
      { action: 'update', botId: saved.id, name: 'Renamed helper' },
      context,
      randomUUID(),
    );
    expect(changed.result).not.toHaveProperty('avatar');
    expect((await request<Bot[]>('/bots')).data.find((bot) => bot.id === saved.id)?.avatar).toBe(
      saved.avatar,
    );
    const freed = (await request<Bot[]>('/bots')).data.find(
      (bot) => children.some((child) => child.id === bot.id) && bot.avatar !== saved.avatar,
    )!;
    expect((await request(`/bots/${freed.id}`, 'DELETE')).status).toBe(200);
    const replacement = await create('Replacement helper');
    expect(
      (await request<Bot[]>('/bots')).data.find((bot) => bot.id === replacement.id)?.avatar,
    ).toBe(freed.avatar);
  });

  it('persists new mascots on creation and edits and resolves saved legacy mascots to Mukai', async () => {
    const created = await request<Bot>('/bots', 'POST', {
      ...input(),
      avatar: 'muka-mascot-5-blue',
    });
    expect(created.status).toBe(201);
    expect(created.data.avatar).toBe('muka-mascot-5-blue');
    const updated = await request<Bot>(`/bots/${created.data.id}`, 'PUT', {
      ...input(),
      avatar: 'muka-mascot-2-orange',
    });
    expect(updated.status).toBe(200);
    expect(updated.data.avatar).toBe('muka-mascot-2-orange');
    expect((await request<Bot[]>('/bots')).data[0].avatar).toBe('muka-mascot-2-orange');
    api.store.run('UPDATE bots SET avatar=? WHERE id=?', 'atlas', created.data.id);
    expect((await request<Bot[]>('/bots')).data[0].avatar).toBe('mukai-logo');
  });

  it('offers web search without a folder, runs it in the SDK loop, records usage, and enforces revocation', async () => {
    const main = await bot();
    const child = await bot('Ada');
    const execute = vi.spyOn(WebSearchService.prototype, 'execute').mockResolvedValue({
      items: [
        {
          target: 'official docs',
          ok: true,
          provider: 'exa',
          fallback: false,
          sources: [
            {
              title: 'Docs',
              url: 'https://example.com/',
              text: 'Public documentation',
              truncated: false,
            },
          ],
        },
      ],
      partial: false,
    });
    expect(api.access.allowed(main, 'web_search')).toBe(true);
    expect(api.access.allowed(child, 'web_search')).toBe(true);
    const catalog = (await request<ToolInfo[]>('/tools')).data;
    expect(catalog.find((item) => item.id === 'web_search')).toMatchObject({
      available: true,
      actions: ['search', 'fetch'],
    });
    await provider();
    mode = 'web-search';
    await chat(child);
    expect(calls[0].tools.map((item) => item.function.name)).toContain('web_search');
    expect(calls[0].messages[0].content).toContain('Cite returned source URLs');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('Public documentation');
    expect(execute).toHaveBeenCalledTimes(1);
    const messages = (await request<ChatMessage[]>(`/bots/${child.id}/messages`)).data;
    expect(messages.flatMap((message) => message.activity || [])).toContainEqual(
      expect.objectContaining({
        tool: 'web_search',
        action: 'search',
        status: 'complete',
      }),
    );
    expect(
      (await request<ToolInfo[]>('/tools')).data.find((item) => item.id === 'web_search')?.counts
        .search,
    ).toBe(1);
    mode = 'web-revoke';
    await chat(main);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('not assigned web_search');
    mode = 'normal';
    await chat(main);
    expect(calls.at(-1)!.tools.map((item) => item.function.name)).not.toContain('web_search');
    const denied = await api.botManagement.create(main, { ...input('Nova'), role: 'Researcher' });
    expect(api.access.allowed(denied, 'web_search')).toBe(false);
  });
  it('requires roles in the API and AI tool, keeps the main role fixed, and supplies names/roles in prompts', async () => {
    for (const role of [undefined, '', '  ']) {
      expect((await request('/bots', 'POST', { ...input('Ada'), role })).status).toBe(400);
    }
    const main = await bot();
    await provider();
    expect(main.role).toBe('Main Bot/Orchestrator');
    expect(main).not.toHaveProperty('description');
    const changed = await request<Bot>(`/bots/${main.id}`, 'PUT', {
      ...input(),
      role: 'Code architect',
    });
    expect(changed.data.role).toBe('Main Bot/Orchestrator');
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const missing = await executeBotManagement(
      { action: 'create', name: 'Ada', instructions: 'Design code.' },
      context,
      randomUUID(),
    );
    expect(missing).toMatchObject({
      ok: false,
      error: 'Create requires name, role, and instructions.',
    });
    const result = await executeBotManagement(
      { action: 'create', name: 'Ada', role: 'Code architect', instructions: 'Design code.' },
      context,
      randomUUID(),
    );
    expect(result.ok).toBe(true);
    const child = result.result as Bot;
    expect(child).toMatchObject({ name: 'Ada', role: 'Code architect', createdBy: main.id });
    expect(api.botManagement.list(main)).toContainEqual(
      expect.objectContaining({ id: child.id, role: 'Code architect' }),
    );
    await chat(main);
    await chat(child);
    const inference = calls.filter((call) => call.stream);
    expect(inference[0].messages[0].content).toContain('human or bot-sounding name');
    expect(inference[1].messages[0].content).toContain('"role":"Code architect"');
    expect(api.store.all('PRAGMA table_info(bots)').map((row) => row.name)).not.toContain(
      'description',
    );
  });
  it('reports effective model capabilities in bot tool results without saving inherited values', async () => {
    const main = await bot();
    const models = [
      {
        id: 'media-model',
        name: 'Media model',
        supportsImages: true,
        supportsAudio: true,
        supportsVideo: true,
        contextWindowTokens: 512000,
        maxOutputTokens: 48000,
        reasoningEffort: 'provider-default',
      },
      {
        id: 'text-model',
        name: 'Text model',
        supportsImages: false,
        supportsAudio: false,
        supportsVideo: false,
        contextWindowTokens: 64000,
        maxOutputTokens: 4096,
      },
    ];
    const saved = await request<{ id: string }>('/providers', 'POST', {
      name: 'Media fixture',
      kind: 'compatible',
      baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
      defaultModel: 'media-model',
      supportsImages: true,
      isDefault: true,
      apiKey: 'test-only-provider-secret',
      models,
    });
    expect(saved.status).toBe(201);
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const invoke = (value: Parameters<typeof executeBotManagement>[0]) =>
      executeBotManagement(value, context, randomUUID());
    const effective = {
      providerId: saved.data.id,
      providerName: 'Media fixture',
      model: 'media-model',
      supportsText: true,
      supportsImages: true,
      supportsAudio: true,
      supportsVideo: true,
      inputCapabilities: 'Text, images, audio, video',
      contextWindowTokens: 512000,
      maxOutputTokens: 48000,
      reasoningEffort: 'provider-default',
    };
    expect(await invoke({ action: 'get', botId: main.id })).toMatchObject({
      ok: true,
      result: effective,
    });
    const created = await invoke({
      action: 'create',
      name: 'Ada',
      role: 'Reviewer',
      instructions: 'Review the task.',
    });
    expect(created).toMatchObject({ ok: true, result: effective });
    const child = created.result as { id: string };
    expect(
      await invoke({ action: 'update', botId: child.id, role: 'Media reviewer' }),
    ).toMatchObject({
      ok: true,
      result: { ...effective, role: 'Media reviewer' },
    });
    // Tool projections must not turn inherited defaults into saved overrides on update.
    expect((await request<Bot[]>('/bots')).data.find((bot) => bot.id === child.id)).toMatchObject({
      providerId: null,
      model: null,
      supportsImages: null,
      contextWindowTokens: null,
      maxOutputTokens: null,
      reasoningEffort: null,
    });
    expect(
      (
        await request(`/bots/${child.id}/model`, 'PUT', {
          providerId: saved.data.id,
          model: 'text-model',
          supportsImages: null,
        })
      ).status,
    ).toBe(200);
    const listed = await invoke({ action: 'list' });
    expect(listed).toMatchObject({
      ok: true,
      result: expect.arrayContaining([
        expect.objectContaining({ id: main.id, ...effective }),
        expect.objectContaining({
          id: child.id,
          model: 'text-model',
          supportsImages: false,
          supportsAudio: false,
          supportsVideo: false,
          inputCapabilities: 'Text only',
          contextWindowTokens: 64000,
          maxOutputTokens: 4096,
        }),
      ]),
    });
    const inspected = await invoke({ action: 'get', botId: child.id });
    expect(inspected).toMatchObject({ ok: true, result: { supportsImages: false } });
    expect(inspected.result).not.toHaveProperty('avatar');
    expect(JSON.stringify([listed, inspected, created])).not.toMatch(
      /test-only-provider-secret|encryptedKey|baseUrl/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('media-model');
    expect(calls[0].stream).not.toBe(true);
  });
  it('keeps bot inspection available without a configured provider and labels capabilities unknown', async () => {
    const main = await bot();
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const inspected = await executeBotManagement(
      { action: 'get', botId: main.id },
      context,
      randomUUID(),
    );
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        model: 'Not configured',
        providerName: 'Not configured',
        supportsImages: 'unknown',
        supportsAudio: 'unknown',
        supportsVideo: 'unknown',
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'unknown',
      },
    });
    expect(api.botManagement.list(main)).toContainEqual(
      expect.objectContaining({ id: main.id, supportsImages: 'unknown' }),
    );
    expect(
      await executeBotManagement(
        { action: 'create', name: 'Ada', role: 'Reviewer', instructions: 'Review.' },
        context,
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Configure a provider') });
    expect((await request<Bot[]>('/bots')).data).toHaveLength(1);
  });
  it('discovers saved models read-only with distinct selection IDs for duplicate model names', async () => {
    const main = await bot(),
      child = await bot('Ada');
    await modelProvider('First provider', '/first');
    await modelProvider('Second provider', '/second', false);
    const before = (await request<ProviderSettings[]>('/providers')).data;
    const context = {
      bot: child,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const listed = await executeBotManagement({ action: 'list_models' }, context, randomUUID());
    expect(listed.ok).toBe(true);
    const entries = listed.result as { modelId: string; model: string; providerName: string }[];
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((model) => model.modelId)).size).toBe(4);
    const duplicates = entries.filter((model) => model.model === 'media-model');
    expect(duplicates).toHaveLength(2);
    const inspected = await executeBotManagement(
      { action: 'get_model', modelId: duplicates[0].modelId },
      context,
      randomUUID(),
    );
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        modelId: duplicates[0].modelId,
        model: 'media-model',
        inputCapabilities: 'Text, images, audio, video',
        contextWindowTokens: 512000,
        maxOutputTokens: 48000,
      },
    });
    expect(api.botManagement.listModels(main)).toEqual(entries);
    expect((await request<ProviderSettings[]>('/providers')).data).toEqual(before);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(listed)).not.toMatch(/catalog-test-secret|encryptedKey|baseUrl/);
    expect(
      await executeBotManagement(
        { action: 'get_model', modelId: 'media-model' },
        context,
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('list_models') });
    expect(botManagementDefinition.inputSchema.safeParse({ action: 'get_model' }).success).toBe(
      false,
    );
    expect(
      botManagementDefinition.inputSchema.safeParse({
        action: 'update',
        botId: main.id,
        modelId: duplicates[0].modelId,
      }).success,
    ).toBe(true);
    expect(
      botManagementDefinition.inputSchema.safeParse({
        action: 'list',
        modelId: duplicates[0].modelId,
      }).success,
    ).toBe(false);
  });
  it('tests the selected provider and nondefault model before creating a bot that uses them', async () => {
    const main = await bot();
    await modelProvider('First provider', '/first');
    const selectedProvider = await modelProvider('Second provider', '/second', false);
    const selected = api.botManagement
      .listModels(main)
      .find((model) => model.providerName === 'Second provider' && model.model === 'media-model')!;
    const result = await executeBotManagement(
      {
        action: 'create',
        name: 'Vision reviewer',
        role: 'Reviewer',
        instructions: 'Review images.',
        modelId: selected.modelId,
      },
      {
        bot: main,
        management: api.botManagement,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { providerId: selectedProvider.id, model: 'media-model', supportsImages: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'media-model' });
    expect(calls[0].stream).not.toBe(true);
    expect(requestPaths).toEqual(['/second/v1/chat/completions']);
    const child = (await request<Bot[]>('/bots')).data.find(
      (bot) => bot.id === (result.result as { id: string }).id,
    )!;
    expect(child).toMatchObject({
      providerId: selectedProvider.id,
      model: 'media-model',
      supportsImages: null,
      contextWindowTokens: null,
      maxOutputTokens: null,
    });
    await chat(child);
    expect(calls.at(-1)).toMatchObject({ model: 'media-model', stream: true });
    expect(requestPaths.at(-1)).toBe('/second/v1/chat/completions');
    expect(
      (await request<ProviderSettings[]>('/providers')).data.find(
        (provider) => provider.id === selectedProvider.id,
      )?.defaultModel,
    ).toBe('text-default');
  });
  it('changes an existing bot’s model after testing it and continues its saved conversation', async () => {
    const main = await bot();
    const oldProvider = await modelProvider('Old provider', '/old');
    const nextProvider = await modelProvider('Next provider', '/next', false);
    const child = (
      await request<Bot>('/bots', 'POST', {
        ...input('Iris'),
        providerId: oldProvider.id,
        model: 'text-default',
        supportsImages: false,
        contextWindowTokens: 8192,
        maxOutputTokens: 512,
        reasoningEffort: 'provider-default',
      })
    ).data;
    await chat(child);
    const history = (await request<ChatMessage[]>(`/bots/${child.id}/messages`)).data;
    const selected = api.botManagement
      .listModels(main)
      .find((model) => model.providerName === 'Next provider' && model.model === 'media-model')!;
    const changed = await executeBotManagement(
      botManagementDefinition.inputSchema.parse({
        action: 'update',
        botId: child.id,
        modelId: selected.modelId,
        role: 'Image reviewer',
      }),
      {
        bot: main,
        management: api.botManagement,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(changed).toMatchObject({
      ok: true,
      result: {
        id: child.id,
        name: 'Iris',
        role: 'Image reviewer',
        createdAt: child.createdAt,
        createdBy: child.createdBy,
        providerId: nextProvider.id,
        model: 'media-model',
        supportsImages: true,
        supportsAudio: true,
        supportsVideo: true,
        contextWindowTokens: 512000,
        maxOutputTokens: 48000,
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ model: 'media-model' });
    expect(calls[1].stream).not.toBe(true);
    expect(requestPaths[1]).toBe('/next/v1/chat/completions');
    const saved = (await request<Bot[]>('/bots')).data.find((bot) => bot.id === child.id)!;
    expect(saved).toMatchObject({
      avatar: child.avatar,
      supportsImages: null,
      contextWindowTokens: null,
      maxOutputTokens: null,
      reasoningEffort: null,
    });
    expect((await request<ChatMessage[]>(`/bots/${child.id}/messages`)).data).toEqual(history);
    await chat(child);
    expect(calls.at(-1)).toMatchObject({ model: 'media-model', stream: true });
    expect(calls.at(-1)!.messages).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: history[1].content }),
    );
    expect(
      (await request<ChatMessage[]>(`/bots/${child.id}/messages`)).data.slice(0, history.length),
    ).toEqual(history);
  });
  it('leaves all bot settings and assignments intact when a model update fails', async () => {
    const main = await bot();
    await modelProvider('Models', '/models');
    const child = await api.botManagement.create(main, input('Ada'), ['browser']);
    const before = api.botManagement.get(main, child.id);
    const assignments = api.access.list('default');
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const update = (modelId: string) =>
      executeBotManagement(
        {
          action: 'update',
          botId: child.id,
          modelId,
          name: 'Should not save',
          instructions: 'Should not save',
          toolIds: [],
        },
        context,
        randomUUID(),
      );
    expect(await update('missing-selection')).toMatchObject({
      ok: false,
      error: expect.stringContaining('list_models'),
    });
    expect(calls).toHaveLength(0);
    mode = 'probe-fail';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const selected = api.botManagement
      .listModels(main)
      .find((model) => model.model === 'media-model')!;
    expect(await update(selected.modelId)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('media-model');
    expect(api.botManagement.get(main, child.id)).toEqual(before);
    expect(api.access.list('default')).toEqual(assignments);
  });
  it('cancels model updates without saving and refuses to change a busy bot', async () => {
    const main = await bot(),
      child = await bot('Ada');
    await modelProvider('Models', '/models');
    const selected = api.botManagement
      .listModels(main)
      .find((model) => model.model === 'media-model')!;
    const before = api.botManagement.get(main, child.id);
    mode = 'probe-slow';
    const controller = new AbortController();
    const pending = executeBotManagement(
      { action: 'update', botId: child.id, modelId: selected.modelId, role: 'Should not save' },
      { bot: main, management: api.botManagement, signal: controller.signal, onActivity() {} },
      randomUUID(),
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(api.botManagement.get(main, child.id)).toEqual(before);
    controller.abort();
    await rejected;
    expect(api.botManagement.get(main, child.id)).toEqual(before);
    mode = 'slow';
    const running = chat(child);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(
      await executeBotManagement(
        { action: 'update', botId: child.id, modelId: selected.modelId },
        {
          bot: main,
          management: api.botManagement,
          signal: new AbortController().signal,
          onActivity() {},
        },
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Stop this bot') });
    expect(calls).toHaveLength(2);
    expect(api.botManagement.get(main, child.id)).toEqual(before);
    await request(`/bots/${child.id}/stop`, 'POST');
    await running;
  });
  it('uses the creator’s current model when modelId is omitted, even with a stale caller snapshot', async () => {
    const main = await bot();
    const saved = await modelProvider('Selected provider', '/selected');
    expect(
      (
        await request(`/bots/${main.id}/model`, 'PUT', {
          providerId: saved.id,
          model: 'media-model',
          supportsImages: null,
        })
      ).status,
    ).toBe(200);
    const result = await executeBotManagement(
      { action: 'create', name: 'Ada', role: 'Reviewer', instructions: 'Review images.' },
      {
        bot: main,
        management: api.botManagement,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { providerId: saved.id, model: 'media-model' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('media-model');
    expect(botManagementDefinition.description).toContain(
      'Creating without modelId defaults to the creator’s current model.',
    );
  });
  it('returns model-selection and connection errors without creating a bot', async () => {
    const main = await bot();
    await modelProvider('Models', '/models');
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const create = (modelId?: string) =>
      executeBotManagement(
        { action: 'create', name: 'Ada', role: 'Reviewer', instructions: 'Review.', modelId },
        context,
        randomUUID(),
      );
    expect(await create('not-a-selection')).toMatchObject({
      ok: false,
      error: expect.stringContaining('list_models'),
    });
    expect(calls).toHaveLength(0);
    mode = 'probe-fail';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const selected = api.botManagement
      .listModels(main)
      .find((model) => model.model === 'media-model')!;
    const failed = await create(selected.modelId);
    expect(failed).toMatchObject({ ok: false, error: expect.any(String) });
    expect(JSON.stringify(failed)).not.toContain('catalog-test-secret');
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('media-model');
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.id)).toEqual([main.id]);
    expect(api.store.all('SELECT * FROM bot_tool_assignments')).toHaveLength(0);
  });
  it('does not save a bot when its connection test is cancelled', async () => {
    const main = await bot();
    await modelProvider('Models', '/models');
    mode = 'probe-slow';
    const controller = new AbortController();
    const pending = executeBotManagement(
      { action: 'create', name: 'Ada', role: 'Reviewer', instructions: 'Review.' },
      { bot: main, management: api.botManagement, signal: controller.signal, onActivity() {} },
      randomUUID(),
    );
    // Attach the rejection handler before aborting the provider request.
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((await request<Bot[]>('/bots')).data).toHaveLength(1);
    controller.abort();
    await rejected;
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.id)).toEqual([main.id]);
  });
  it('uses the bot’s selected model on actual inference, resets old model limits, and preserves its other fields', async () => {
    const main = await bot(),
      child = await bot('Ada');
    await provider();
    await chat(main);
    expect(calls.at(-1)!.model).toBe('test');
    const selected = await request<Bot>(`/bots/${main.id}/model`, 'PUT', {
      providerId: null,
      model: 'architect-model',
      contextWindowTokens: 65536,
      supportsImages: false,
      name: 'Ignored',
      role: 'Ignored',
    });
    expect(selected.status).toBe(200);
    expect(selected.data).toMatchObject({
      name: 'Mukai',
      role: 'Main Bot/Orchestrator',
      model: 'architect-model',
      contextWindowTokens: null,
    });
    await chat(selected.data);
    expect(calls.at(-1)!.model).toBe('architect-model');
    await chat(child);
    expect(calls.at(-1)!.model).toBe('test');
    const next = await request<Bot>(`/bots/${main.id}/model`, 'PUT', {
      providerId: null,
      model: 'another-model',
      supportsImages: null,
    });
    expect(next.data.contextWindowTokens).toBeNull();
    await chat(next.data);
    expect(calls.at(-1)!.model).toBe('another-model');
    const reset = await request<Bot>(`/bots/${main.id}/model`, 'PUT', {
      providerId: null,
      model: null,
      supportsImages: null,
    });
    await chat(reset.data);
    expect(calls.at(-1)!.model).toBe('test');
    expect((await request<{ defaultModel: string }[]>('/providers')).data[0].defaultModel).toBe(
      'test',
    );
    mode = 'slow';
    const pending = chat(main);
    await waitFor(() => expect(calls).toHaveLength(6));
    expect(
      (
        await request(`/bots/${main.id}/model`, 'PUT', {
          providerId: null,
          model: 'blocked-change',
          supportsImages: null,
        })
      ).status,
    ).toBe(409);
    await request(`/bots/${main.id}/stop`, 'POST');
    await pending;
  });
  it('starts every workspace empty, creates its main bot without a provider, and keeps hierarchy on edits', async () => {
    expect((await request<Bot[]>('/bots')).data).toEqual([]);
    mkdirSync(join(root, 'project'));
    const workspace = (
      await request<{ id: string }>('/workspaces', 'POST', {
        name: 'Project',
        folder: join(root, 'project'),
      })
    ).data;
    expect((await request<Bot[]>(`/bots?workspaceId=${workspace.id}`)).data).toEqual([]);
    const main = await bot(),
      child = await bot('Scout'),
      other = await bot('Atlas', workspace.id);
    expect(main).toMatchObject({ isMain: true, createdBy: null, providerId: null });
    expect(child).toMatchObject({ isMain: false, createdBy: main.id });
    expect(other).toMatchObject({ isMain: true, createdBy: null });
    const edited = await request<Bot>(`/bots/${child.id}`, 'PUT', {
      ...input('New name'),
      isMain: true,
      createdBy: null,
    });
    expect(edited.data).toMatchObject({ isMain: false, createdBy: main.id });
    expect((await request(`/bots/${main.id}`, 'DELETE')).status).toBe(409);
    const send = await request<{ error: string }>(`/bots/${main.id}/chat`, 'POST', {
      requestId: randomUUID(),
      text: 'Hello',
      attachmentIds: [],
    });
    expect(send.status).toBe(400);
    expect(send.data.error).toContain('provider');
    expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data).toEqual([]);
  });
  it('offers all tools to the main bot and ordinary tools to children, with live assignment enforcement', async () => {
    const main = await bot(),
      child = await bot('Scout');
    expect(api.memory.settings(main.workspaceId).enabled).toBe(false);
    api.memory.saveSettings(main.workspaceId, {
      ...api.memory.settings(main.workspaceId),
      enabled: true,
    });
    await provider();
    await chat(main);
    await chat(child);
    const names = (index: number) => calls[index].tools.map((item) => item.function.name);
    expect(names(0)).toEqual(
      expect.arrayContaining([
        'manage_pursuit',
        'manage_bot',
        'memory',
        'browser',
        'register_custom_tool',
        'skills',
        'register_custom_route',
      ]),
    );
    expect(names(1)).not.toContain('manage_pursuit');
    expect(names(1)).toContain('manage_bot');
    expect(
      calls[0].tools.find((tool) => tool.function.name === 'manage_bot')!.function.parameters
        .properties.action!.enum,
    ).toEqual([
      'create',
      'update',
      'delete',
      'list',
      'get',
      'list_models',
      'get_model',
      'send_message',
      'get_last_message',
    ]);
    expect(
      calls[1].tools.find((tool) => tool.function.name === 'manage_bot')!.function.parameters
        .properties.action!.enum,
    ).toEqual(['list', 'get', 'list_models', 'get_model', 'send_message', 'get_last_message']);
    for (const target of [main, child])
      expect(
        (
          await request('/tools/assignments', 'PUT', {
            botId: target.id,
            toolId: 'manage_bot',
            enabled: false,
          })
        ).status,
      ).toBe(400);
    expect(names(1)).toEqual(
      expect.arrayContaining(['memory', 'browser', 'skills', 'register_custom_route']),
    );
    expect(
      (
        await request('/tools/assignments', 'PUT', {
          botId: child.id,
          toolId: 'manage_pursuit',
          enabled: true,
        })
      ).status,
    ).toBe(200);
    await chat(child);
    expect(names(2)).toContain('manage_pursuit');
    expect(
      (
        await request('/tools/assignments', 'PUT', {
          botId: child.id,
          toolId: 'manage_bot',
          enabled: true,
        })
      ).status,
    ).toBe(200);
    await chat(child);
    expect(names(3)).toContain('manage_bot');
    const execute = vi.spyOn(api.browsers, 'execute');
    mode = 'revoke';
    await chat(main);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('not assigned browser');
  });
  it('scopes assignments to the workspace, shares skills/routes, and persists overrides', async () => {
    const main = await bot(),
      child = await bot('Scout');
    mkdirSync(join(root, 'project'));
    const workspace = (
      await request<{ id: string }>('/workspaces', 'POST', {
        name: 'Other',
        folder: join(root, 'project'),
      })
    ).data;
    const foreign = await bot('Other', workspace.id);
    expect(
      (
        await request('/tools/assignments', 'PUT', {
          botId: foreign.id,
          toolId: 'browser',
          enabled: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/tools/assignments', 'PUT', {
          botId: child.id,
          toolId: 'skills',
          enabled: false,
        })
      ).status,
    ).toBe(400);
    expect(api.access.allowed(child, 'skills')).toBe(true);
    expect(api.access.allowed(child, 'register_custom_route')).toBe(true);
    api.store.run('INSERT INTO bot_tool_assignments VALUES(?,?,?)', child.id, 'manage_bot', 0);
    api.store.run('INSERT INTO bot_tool_assignments VALUES(?,?,?)', main.id, 'manage_bot', 0);
    expect(api.access.allowed(child, 'manage_bot')).toBe(true);
    expect(api.access.allowed(main, 'manage_bot')).toBe(true);
    api.access.set('default', main.id, 'terminal', false);
    expect(api.access.allowed(main, 'process')).toBe(false);
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api = await startApiServer(0, {
      dataDir: join(root, 'data'),
      memoryExtractor: async () => ({ facts: [] }),
    });
    expect(api.access.allowed(child, 'manage_bot')).toBe(true);
    expect(api.access.allowed(main, 'process')).toBe(false);
    expect((await request<Bot[]>('/bots')).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: child.id, createdBy: main.id })]),
    );
  });
  it('shares custom tools by default while respecting explicit assignments by stable registration ID', async () => {
    const main = await bot(),
      child = await bot('Scout');
    mkdirSync(join(root, 'project'));
    await request('/workspaces/default', 'PUT', { name: 'Project', folder: join(root, 'project') });
    writeFileSync(
      join(root, 'project', 'echo.ts'),
      `export default {name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{}},execute:()=>({ok:true})};`,
    );
    const registration = await api.capabilities.manage('default', main.id, 'tool', {
      operation: 'register',
      modulePath: 'echo.ts',
      permissionMode: 'auto_approve',
    });
    const id = 'custom:' + (registration as { id: string }).id;
    expect(api.access.allowed(main, id)).toBe(true);
    expect(api.access.allowed(child, id)).toBe(true);
    await provider();
    await chat(child);
    expect(calls[0].tools.map((item) => item.function.name)).toContain('echo');
    api.access.set('default', child.id, id, false);
    await chat(child);
    expect(calls[1].tools.map((item) => item.function.name)).not.toContain('echo');
    expect(api.access.list('default')).toContainEqual({
      botId: child.id,
      toolId: id,
      enabled: false,
    });
  });
  it('accepts process as the terminal assignment alias when creating children and changing access', async () => {
    const main = await bot();
    const child = await api.botManagement.create(main, input('VM helper'), ['terminal', 'process']);
    expect(api.access.allowed(child, 'terminal')).toBe(true);
    expect(api.access.allowed(child, 'process')).toBe(true);
    expect(api.access.allowed(child, 'browser')).toBe(false);
    const aliasOnly = await api.botManagement.create(main, input('Process helper'), ['process']);
    expect(api.access.allowed(aliasOnly, 'terminal')).toBe(true);
    expect(api.access.allowed(aliasOnly, 'process')).toBe(true);
    expect(api.access.set('default', child.id, 'process', false)).toEqual({
      botId: child.id,
      toolId: 'terminal',
      enabled: false,
    });
    expect(api.access.allowed(child, 'terminal')).toBe(false);
    expect(api.access.allowed(child, 'process')).toBe(false);
    api.access.set('default', main.id, 'terminal', false);
    await expect(api.botManagement.create(main, input('Denied'), ['process'])).rejects.toThrow(
      'cannot grant',
    );
    await expect(
      api.botManagement.create(main, input('Invalid'), ['unknown-tool']),
    ).rejects.toThrow('Choose a workspace');
  });
  it('reserves creation and updates for the main bot, bounds grants, and requires Bots access', async () => {
    const main = await bot(),
      peer = await bot('Peer');
    await provider();
    expect(() => api.access.set('default', peer.id, 'manage_bot', false)).toThrow(
      'Bots access is required',
    );
    await expect(api.botManagement.create(peer, input('Denied'))).rejects.toThrow(
      'Only the workspace main bot',
    );
    api.access.set('default', main.id, 'terminal', false);
    await expect(api.botManagement.create(main, input('Denied'), ['terminal'])).rejects.toThrow(
      'cannot grant',
    );
    const result = await executeBotManagement(
      {
        action: 'create',
        name: 'Researcher',
        role: 'Researcher',
        instructions: 'Research the task.',
        toolIds: ['manage_bot', 'browser'],
      },
      {
        bot: main,
        management: api.botManagement,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(result.ok).toBe(true);
    const child = result.result as Bot;
    expect(child).toMatchObject({ createdBy: main.id, isMain: false });
    expect(api.access.allowed(child, 'manage_bot')).toBe(true);
    expect(api.access.allowed(child, 'memory')).toBe(false);
    await expect(api.botManagement.create(child, input('Helper'))).rejects.toThrow(
      'Only the workspace main bot',
    );
    await expect(api.botManagement.update(child, peer.id, { name: 'Renamed' })).rejects.toThrow(
      'Only the workspace main bot',
    );
    expect(api.botManagement.get(child, peer.id).id).toBe(peer.id);
    const updated = await api.botManagement.update(main, child.id, {
      name: 'Ada',
      role: 'Research specialist',
      toolIds: [],
    });
    expect(updated).toMatchObject({
      name: 'Ada',
      role: 'Research specialist',
      isMain: false,
      createdBy: main.id,
    });
    expect(api.access.allowed(updated, 'browser')).toBe(false);
    expect(api.access.allowed(updated, 'manage_bot')).toBe(true);
    expect((await request<Bot[]>('/bots')).data).toHaveLength(3);
    for (const target of [main, child]) {
      await expect(
        api.botManagement.sendMessage(child, target.id, 'Work', new AbortController().signal),
      ).rejects.toThrow('only peers or lower-level');
    }
  });
  it('sends real child work through the SDK tool and returns its saved response to the caller', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Researcher'));
    delegatedId = child.id;
    mode = 'delegate';
    await chat(main);
    const childCall = calls.find((call) =>
      call.messages.some((item) =>
        item.content?.includes('This message is coming from another bot'),
      ),
    )!;
    expect(JSON.stringify(childCall.messages)).toContain('Review the notes.');
    expect(
      childCall.tools.find((tool) => tool.function.name === 'manage_bot')!.function.parameters
        .properties.action!.enum,
    ).toEqual(['list', 'get', 'list_models', 'get_model', 'get_last_message']);
    expect(JSON.stringify(childCall.messages)).toContain(
      'intentionally unavailable to prevent delegation loops',
    );
    expect(JSON.stringify(childCall.messages)).toContain(main.name);
    expect(JSON.stringify(childCall.messages)).toContain(main.role);
    expect(JSON.stringify(childCall.messages)).toContain('final reply will be sent directly back');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('Reviewed the notes successfully.');
    const conversations = (await request<Conversation[]>('/conversations?kind=bot')).data;
    expect(conversations).toHaveLength(1);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain(conversations[0].id);
    const saved = (await request<ChatMessage[]>(`/conversations/${conversations[0].id}/messages`))
      .data;
    expect(saved[0]).toMatchObject({
      botId: main.id,
      authorName: main.name,
      content: 'Review the notes.',
    });
    expect(saved.at(-1)).toMatchObject({
      status: 'complete',
      content: 'Reviewed the notes successfully.',
    });
  });
  it('requires an explicit send mode and validates the latest-reply action', async () => {
    const main = await bot(),
      child = await bot('Ada');
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    expect(
      botManagementDefinition.inputSchema.safeParse({
        action: 'send_message',
        botId: child.id,
        message: 'Work',
      }).success,
    ).toBe(false);
    expect(
      await executeBotManagement(
        { action: 'send_message', botId: child.id, message: 'Work' },
        context,
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('mode') });
    expect(
      await executeBotManagement(
        { action: 'get_last_message', botId: child.id },
        context,
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('conversationId') });
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(0);
  });
  it('dispatches without waiting and lets the caller poll the latest reply', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    sendMode = 'fire_and_forget';
    mode = 'delegate-slow';
    await chat(main);
    const conversations = (await request<Conversation[]>('/conversations?kind=bot')).data;
    expect(conversations).toHaveLength(1);
    const conversationId = conversations[0].id;
    const latest = api.botManagement.getLastMessage(main, child.id, conversationId);
    expect(latest).toMatchObject({ botId: child.id, conversationId, status: 'streaming' });
    expect(latest.requestId).toBeTruthy();
    expect(conversations[0].isWorking).toBe(true);
    const parent = (await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)!;
    expect(parent.status).toBe('complete');
    const saved = api.store.get(
      'SELECT * FROM bot_delegations WHERE parent_message_id=?',
      parent.id,
    )!;
    expect(saved.state).toBe('complete');
    await request(`/bots/${main.id}/stop`, 'POST');
    expect(api.botManagement.getLastMessage(main, child.id, conversationId).status).toBe(
      'streaming',
    );
    const replay = await api.botManagement.sendMessage(
      main,
      child.id,
      'Review the notes.',
      new AbortController().signal,
      conversationId,
      {
        parentMessageId: parent.id,
        toolCallId: 'send-message-call',
        onStarted() {},
      },
      'fire_and_forget',
    );
    expect(replay.requestId).toBe(latest.requestId);
    expect(
      (await request<ChatMessage[]>(`/conversations/${conversationId}/messages`)).data,
    ).toHaveLength(2);
    await request(`/conversations/${conversationId}/stop`, 'POST');
    await waitFor(() =>
      expect(api.botManagement.getLastMessage(main, child.id, conversationId).status).toBe(
        'stopped',
      ),
    );
    expect(api.botManagement.getLastMessage(main, child.id, conversationId).status).toBe('stopped');
    mode = 'normal';
    const context = {
      bot: main,
      management: api.botManagement,
      signal: new AbortController().signal,
      onActivity() {},
    };
    const result = await executeBotManagement(
      {
        action: 'send_message',
        botId: child.id,
        conversationId,
        message: 'Finish the review.',
        mode: 'wait',
      },
      context,
      randomUUID(),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { status: 'complete', response: 'Reviewed the notes successfully.' },
    });
    expect(
      await executeBotManagement(
        { action: 'get_last_message', botId: child.id, conversationId },
        context,
        randomUUID(),
      ),
    ).toMatchObject(result);
    expect(api.botManagement.getLastMessage(main, child.id, conversationId).requestId).not.toBe(
      latest.requestId,
    );
    const other = await bot('Other');
    expect(() => api.botManagement.getLastMessage(other, child.id, conversationId)).toThrow(
      'between you and the target',
    );
    expect(() => api.botManagement.getLastMessage(main, child.id, 'bot-' + child.id)).toThrow(
      'between you and the target',
    );
  });
  async function restart(snapshot?: string) {
    await api.shutdown();
    api.server.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    if (snapshot) copyFileSync(snapshot, join(root, 'data', 'mukai.sqlite'));
    api = await startApiServer(0, {
      dataDir: join(root, 'data'),
      memoryExtractor: async () => ({ facts: [] }),
    });
  }
  it('resumes a waiting parent and the same child request after closing the app', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-slow';
    const pending = chat(main);
    await waitFor(() => expect(calls).toHaveLength(2));
    const parent = (await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)!;
    expect(parent.activity?.[0].delegation).toMatchObject({ botId: child.id, botName: 'Ada' });
    const conversationId = parent.activity![0].delegation!.conversationId;
    const before = (await request<ChatMessage[]>(`/conversations/${conversationId}/messages`)).data;
    expect(
      (await request<Conversation[]>('/conversations?kind=bot')).data.find(
        (conversation) => conversation.id === conversationId,
      )?.isWorking,
    ).toBe(true);
    expect(
      (await request<Conversation[]>('/conversations?kind=private')).data.find(
        (conversation) => conversation.ownerBotId === main.id,
      )?.isWorking,
    ).toBe(true);
    await restart();
    await pending;
    expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
      'streaming',
    );
    mode = 'delegate';
    // Release the restored inference request; restarting once more avoids a hanging fixture socket.
    await restart();
    await waitFor(async () => {
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)).toMatchObject(
        { id: parent.id, status: 'complete' },
      );
    });
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(1);
    const after = (await request<ChatMessage[]>(`/conversations/${conversationId}/messages`)).data;
    expect(after).toHaveLength(2);
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.map((item) => item.requestId)).toEqual(before.map((item) => item.requestId));
    expect(after.at(-1)?.status).toBe('complete');
    expect((await request<Conversation[]>('/conversations?kind=bot')).data[0].isWorking).toBe(
      false,
    );
    expect(
      calls.filter(
        (call) =>
          !call.messages.some((item) => item.role === 'tool') &&
          !call.messages.some((item) =>
            item.content?.includes('This message is coming from another bot'),
          ),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Reviewed the notes successfully.');
  });
  it('keeps a child approval visible and actionable in the waiting parent after restart', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-approval';
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const approval = (await request<ApprovalState>('/approvals')).data.pending[0];
    expect(approval).toMatchObject({
      botName: 'Ada',
      blockedParents: [{ botId: main.id, botName: main.name, conversationId: 'bot-' + main.id }],
    });
    await restart();
    await pending;
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((await request<ApprovalState>('/approvals')).data.pending[0]).toMatchObject({
      id: approval.id,
      blockedParents: approval.blockedParents,
    });
    await waitFor(async () =>
      expect((await request(`/approvals/${approval.id}`, 'POST', { approved: true })).status).toBe(
        200,
      ),
    );
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
    expect(
      (await request<ChatMessage[]>(`/conversations/${approval.conversationId}/messages`)).data,
    ).toHaveLength(2);
    // Neither the parent tool call nor the child's permission prompt was regenerated.
    expect(calls).toHaveLength(4);
  });
  it('recovers a child’s empty continuation and sends the saved user answer back to its parent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Nova'));
    delegatedId = child.id;
    mode = 'delegate-empty-once';
    invalidAskFirst = true;
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const question = (await request<ApprovalState>('/approvals')).data.pending[0];
    await request(`/approvals/${question.id}`, 'POST', { answer: 'A meal or treat' });
    await pending;
    const saved = (
      await request<ChatMessage[]>(`/conversations/${question.conversationId}/messages`)
    ).data.at(-1)!;
    expect(saved).toMatchObject({
      status: 'complete',
      content: 'The user chose: A meal or treat.',
    });
    expect(saved.activity).toHaveLength(2);
    expect(saved.activity?.[1].summary).toContain('User answer: A meal or treat');
    expect(calls).toHaveLength(6);
    expect(calls[4]).not.toHaveProperty('tools');
    expect(calls[4].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('write the final reply'),
    });
    expect(JSON.stringify(calls[4].messages)).toContain('A meal or treat');
    expect(JSON.stringify(calls[5].messages)).toContain('The user chose: A meal or treat.');
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
    const logs = readFileSync(join(root, 'data', 'logs', 'errors.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logs).toMatchObject([
      { event: 'chat.tool_input_invalid', level: 'warn', messageId: saved.id },
      { event: 'chat.tool_input_corrected', level: 'info', messageId: saved.id },
      { event: 'chat.empty_reply_recovery', level: 'info', messageId: saved.id },
      { event: 'chat.empty_reply_recovered', level: 'info', messageId: saved.id },
    ]);
    for (const entry of logs.slice(1)) expect(entry).not.toHaveProperty('error');
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain('A meal or treat');
    expect(JSON.stringify(logs)).not.toContain('PRIVATE INVALID QUESTION');
  });
  it('bounds empty-reply recovery, preserves the answer, and logs the exhausted attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Nova'));
    delegatedId = child.id;
    mode = 'delegate-empty-always';
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const question = (await request<ApprovalState>('/approvals')).data.pending[0];
    await request(`/approvals/${question.id}`, 'POST', { answer: 'A meal or treat' });
    await pending;
    const saved = (
      await request<ChatMessage[]>(`/conversations/${question.conversationId}/messages`)
    ).data.at(-1)!;
    expect(saved.status).toBe('failed');
    expect(saved.error).toContain('after two recovery attempts');
    expect(saved.activity).toHaveLength(1);
    expect(saved.activity?.[0].summary).toContain('User answer: A meal or treat');
    expect(calls).toHaveLength(6);
    for (const call of calls.slice(3, 5)) expect(call).not.toHaveProperty('tools');
    const logs = readFileSync(join(root, 'data', 'logs', 'errors.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logs.map((entry) => entry.event)).toEqual([
      'chat.empty_reply_recovery',
      'chat.empty_reply_recovery',
      'chat.empty_reply_failed',
    ]);
    expect(logs[2]).toMatchObject({ level: 'error', messageId: saved.id });
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
  });
  it('keeps empty-reply recovery tool-free after restarting a waiting delegation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Nova'));
    delegatedId = child.id;
    mode = 'delegate-empty-restart';
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const question = (await request<ApprovalState>('/approvals')).data.pending[0];
    await request(`/approvals/${question.id}`, 'POST', { answer: 'A meal or treat' });
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3]).not.toHaveProperty('tools');
    mode = 'delegate-empty-once';
    await restart();
    await pending;
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect(calls).toHaveLength(6);
    expect(calls[4]).not.toHaveProperty('tools');
    expect(calls[4].messages.at(-1)?.content).toContain('[Mukai runtime continuation');
    expect(JSON.stringify(calls[4].messages)).toContain('A meal or treat');
    expect(
      (await request<ChatMessage[]>(`/conversations/${question.conversationId}/messages`)).data.at(
        -1,
      ),
    ).toMatchObject({ status: 'complete', content: 'The user chose: A meal or treat.' });
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
  });
  it('restores a crash-time database snapshot without relying on graceful shutdown', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-slow';
    const pending = chat(main);
    await waitFor(() => expect(calls).toHaveLength(2));
    const snapshot = join(root, 'crash.sqlite');
    api.store.run('VACUUM INTO ?', snapshot);
    await api.shutdown();
    await pending;
    api.server.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    // Restore exactly what was durable while the child was running, before any shutdown callbacks.
    copyFileSync(snapshot, join(root, 'data', 'mukai.sqlite'));
    mode = 'delegate';
    api = await startApiServer(0, {
      dataDir: join(root, 'data'),
      memoryExtractor: async () => ({ facts: [] }),
    });
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });
  it('forwards child tool permissions and does not ask again for an already started parent delegation', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-tool-approval';
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    let permission = (await request<ApprovalState>('/approvals')).data.pending[0];
    expect(permission.toolName).toBe('manage_bot');
    await request(`/approvals/${permission.id}`, 'POST', { approved: true });
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending[0]?.toolName).toBe(
        'browser',
      ),
    );
    permission = (await request<ApprovalState>('/approvals')).data.pending[0];
    expect(permission.blockedParents?.[0].botId).toBe(main.id);
    await restart();
    await pending;
    const restored = (await request<ApprovalState>('/approvals')).data.pending;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: permission.id, toolName: 'browser' });
    await waitFor(async () =>
      expect(
        (
          await request(`/approvals/batch`, 'POST', {
            conversationId: permission.conversationId,
            batchId: permission.batchId,
            ids: [permission.id],
            approved: false,
          })
        ).status,
      ).toBe(200),
    );
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect(calls).toHaveLength(4);
  });
  it('delivers an already completed child result after a crash without running the child again', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate';
    const send = api.botManagement.sendMessage.bind(api.botManagement);
    let childFinished = false;
    vi.spyOn(api.botManagement, 'sendMessage').mockImplementation(async (...args) => {
      const result = await send(...args);
      childFinished = true;
      // Crash window: the child is saved, but the parent has not received its tool result yet.
      await new Promise<void>((_resolve, reject) =>
        args[3].addEventListener('abort', () => reject(args[3].reason), { once: true }),
      );
      return result;
    });
    const pending = chat(main);
    await waitFor(() => expect(childFinished).toBe(true));
    expect(calls).toHaveLength(2);
    const snapshot = join(root, 'completed-child-crash.sqlite');
    api.store.run('VACUUM INTO ?', snapshot);
    await restart(snapshot);
    await pending;
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect(calls).toHaveLength(3);
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(1);
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Reviewed the notes successfully.');
  });
  it('stops the waiting chain when changed settings make its checkpoint incompatible', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-approval';
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    api.store.run('UPDATE bots SET instructions=? WHERE id=?', 'Different instructions.', main.id);
    await restart();
    await pending;
    await waitFor(async () => {
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'interrupted',
      );
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
    });
    expect(calls).toHaveLength(2);
  });
  it('rejects recursive delegation even when a delegated sub-bot attempts send_message', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    const other = await api.botManagement.create(main, input('Nova'));
    delegatedId = child.id;
    nestedId = other.id;
    mode = 'delegate-nested';
    await chat(main);
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(1);
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
    const conversation = (await request<Conversation[]>('/conversations?kind=bot')).data[0];
    const reply = (
      await request<ChatMessage[]>(`/conversations/${conversation.id}/messages`)
    ).data.at(-1)!;
    expect(api.botManagement.actionsFor(child, reply.id)).toEqual([
      'list',
      'get',
      'list_models',
      'get_model',
      'get_last_message',
    ]);
    const result = await executeBotManagement(
      { action: 'send_message', botId: other.id, message: 'Nested work', mode: 'wait' },
      {
        bot: child,
        management: api.botManagement,
        messageId: reply.id,
        signal: new AbortController().signal,
        onActivity() {},
      },
      randomUUID(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('intentionally unavailable'),
    });
    await restart();
    expect(api.botManagement.actionsFor(child, reply.id)).toEqual([
      'list',
      'get',
      'list_models',
      'get_model',
      'get_last_message',
    ]);
    expect(api.botManagement.actionsFor(main, reply.id)).toContain('send_message');
  });
  it('does not restart an explicitly stopped delegation', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-slow';
    const pending = chat(main);
    await waitFor(() => expect(calls).toHaveLength(2));
    await request(`/bots/${main.id}/stop`, 'POST');
    await pending;
    const before = calls.length;
    mode = 'delegate';
    await restart();
    expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
      'stopped',
    );
    expect(calls).toHaveLength(before);
  });
  it('restores a pursuit run waiting on a child without creating another run or request', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    delegatedId = child.id;
    mode = 'delegate-pursuit';
    const pursuit = api.pursuits.create(main, {
      name: 'Review',
      objective: 'Delegate a review.',
      successCriteria: 'Review complete.',
      firstRunAt: new Date(Date.now() + 60000).toISOString(),
      deadline: null,
    });
    const run = api.pursuits.runNow(pursuit.id);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const permission = (await request<ApprovalState>('/approvals')).data.pending[0];
    expect(permission.blockedParents?.[0].conversationId).toBe(run.conversationId);
    await restart();
    expect(api.pursuits.detail(pursuit.id).runs).toHaveLength(1);
    expect(api.pursuits.detail(pursuit.id).runs[0]).toMatchObject({
      id: run.id,
      status: 'running',
    });
    await waitFor(async () =>
      expect(
        (await request(`/approvals/${permission.id}`, 'POST', { approved: true })).status,
      ).toBe(200),
    );
    await waitFor(() => expect(api.pursuits.detail(pursuit.id).runs[0].status).toBe('complete'));
    expect(api.pursuits.detail(pursuit.id).pursuit.status).toBe('completed');
    expect(
      (await request<ChatMessage[]>(`/conversations/${run.conversationId}/messages`)).data,
    ).toHaveLength(2);
    expect(calls).toHaveLength(5);
  });
  it('continues only the requested pair thread, preserves history, and keeps the viewer read-only', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    const other = await api.botManagement.create(main, input('Nova'), ['manage_bot']);
    const signal = new AbortController().signal;
    const first = await api.botManagement.sendMessage(
      main,
      child.id,
      'Remember the blue folder.',
      signal,
    );
    const second = await api.botManagement.sendMessage(
      main,
      child.id,
      'Which folder?',
      signal,
      first.conversationId,
    );
    expect(second.conversationId).toBe(first.conversationId);
    expect(
      calls
        .at(-1)!
        .messages.some((message) => message.content?.includes('Remember the blue folder.')),
    ).toBe(true);
    const history = (
      await request<ChatMessage[]>(`/conversations/${first.conversationId}/messages`)
    ).data;
    expect(history).toHaveLength(4);
    expect(history.map((message) => message.botId)).toEqual([main.id, child.id, main.id, child.id]);
    expect(history.map((message) => message.authorName)).toEqual([
      main.name,
      child.name,
      main.name,
      child.name,
    ]);
    const fresh = await api.botManagement.sendMessage(main, child.id, 'Start afresh.', signal);
    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect(
      calls
        .at(-1)!
        .messages.some((message) => message.content?.includes('Remember the blue folder.')),
    ).toBe(false);
    await expect(
      api.botManagement.sendMessage(main, other.id, 'Wrong pair', signal, first.conversationId),
    ).rejects.toThrow('between you and the target');
    await expect(
      api.botManagement.sendMessage(other, child.id, 'Not my thread', signal, first.conversationId),
    ).rejects.toThrow('between you and the target');
    await expect(
      api.botManagement.sendMessage(main, child.id, 'Private chat', signal, 'bot-' + child.id),
    ).rejects.toThrow('between you and the target');
    expect(
      (
        await request(`/conversations/${first.conversationId}/chat`, 'POST', {
          requestId: randomUUID(),
          text: 'Human message',
          attachmentIds: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`/conversations/${first.conversationId}/attachments`, 'POST')).status,
    ).toBe(400);
    const pairChats = (await request<Conversation[]>('/conversations?kind=bot')).data;
    expect(pairChats).toHaveLength(2);
    expect(pairChats[0]).toMatchObject({
      kind: 'bot',
      workspaceId: 'default',
      botIds: [main.id, child.id],
    });
    expect(
      (await request<Conversation[]>('/conversations?kind=private')).data.every(
        (chat) => !pairChats.some((pair) => pair.id === chat.id),
      ),
    ).toBe(true);
    expect((await request<Conversation[]>('/conversations')).data).toEqual([]);
    expect(botManagementDefinition.inputSchema.safeParse({ action: 'spawn' }).success).toBe(false);
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('allows peer and lower-level messaging across branches, but rejects every higher-level target', async () => {
    const main = await bot();
    await provider();
    const ada = await api.botManagement.create(main, input('Ada'), ['manage_bot']);
    const nova = await api.botManagement.create(main, input('Nova'), ['manage_bot']);
    const junior = await api.botManagement.create(main, input('Junior'));
    const colleague = await api.botManagement.create(main, input('Colleague'));
    api.store.run('UPDATE bots SET created_by=? WHERE id=?', ada.id, junior.id);
    api.store.run('UPDATE bots SET created_by=? WHERE id=?', nova.id, colleague.id);
    const signal = new AbortController().signal;
    for (const target of [main, ada, nova])
      await expect(
        api.botManagement.sendMessage(junior, target.id, 'Upward', signal),
      ).rejects.toThrow('higher-level');
    const peer = await api.botManagement.sendMessage(ada, nova.id, 'Hello peer', signal);
    await api.botManagement.sendMessage(
      nova,
      ada.id,
      'Continue from the other side',
      signal,
      peer.conversationId,
    );
    const reverseHistory = (
      await request<ChatMessage[]>(`/conversations/${peer.conversationId}/messages`)
    ).data;
    expect(reverseHistory.map((message) => message.botId)).toEqual([
      ada.id,
      nova.id,
      nova.id,
      ada.id,
    ]);
    const reverseCall = calls.at(-1)!;
    expect(
      reverseCall.messages.find((message) => message.content?.includes('Hello peer'))?.role,
    ).toBe('assistant');
    expect(
      await api.botManagement.sendMessage(ada, colleague.id, 'Lower other branch', signal),
    ).toMatchObject({ status: 'complete' });
    expect(
      await api.botManagement.sendMessage(junior, colleague.id, 'Same depth', signal),
    ).toMatchObject({ status: 'complete' });
    expect(api.botManagement.list(main)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: main.id, hierarchyLevel: 0 }),
        expect.objectContaining({ id: ada.id, hierarchyLevel: 1 }),
        expect.objectContaining({ id: junior.id, createdBy: ada.id, hierarchyLevel: 2 }),
      ]),
    );
    expect(api.access.allowed(junior, 'manage_bot')).toBe(true);
    const noTools = await api.botManagement.create(main, input('Restricted'), []);
    expect(api.access.allowed(noTools, 'manage_bot')).toBe(true);
    expect(
      await api.botManagement.sendMessage(noTools, colleague.id, 'Focused help', signal),
    ).toMatchObject({ status: 'complete' });
  });
  it('rejects cross-workspace and simultaneous messages, propagates cancellation, and releases the child', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Child'));
    mode = 'slow';
    const controller = new AbortController();
    const pending = api.botManagement.sendMessage(
      main,
      child.id,
      'Wait for work',
      controller.signal,
    );
    const stopped = expect(pending).rejects.toThrow();
    await waitFor(() => expect(calls).toHaveLength(1));
    await expect(
      api.botManagement.sendMessage(main, child.id, 'Other work', new AbortController().signal),
    ).rejects.toThrow('already working');
    controller.abort();
    await stopped;
    mode = 'normal';
    const completed = await api.botManagement.sendMessage(
      main,
      child.id,
      'Try again',
      new AbortController().signal,
    );
    expect(completed.status).toBe('complete');
    mkdirSync(join(root, 'project'));
    const workspace = (
      await request<{ id: string }>('/workspaces', 'POST', {
        name: 'Other',
        folder: join(root, 'project'),
      })
    ).data;
    const foreign = await bot('Foreign', workspace.id);
    await expect(
      api.botManagement.sendMessage(main, foreign.id, 'Work', new AbortController().signal),
    ).rejects.toThrow('only peers or lower-level');
  });
});
