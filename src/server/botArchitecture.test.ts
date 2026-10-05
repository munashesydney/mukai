import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import type { Bot, BotInput, ChatMessage } from '../shared/ai';
import { executeBotManagement } from './tools/bots/execute';
import { WebSearchService } from './services/webSearchService';
import type { ToolInfo } from '../shared/ai';
import type { Conversation } from '../shared/conversations';
import { botManagementDefinition } from './tools/bots/definition';
import type { ApprovalState } from '../shared/approvals';

let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, root: string;
let calls: {
  model: string;
  tools: { function: { name: string } }[];
  messages: { role: string; content: string; tool_call_id?: string }[];
}[];
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
  | 'web-revoke';
let delegatedId: string;
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
  mode = 'normal';
  delegatedId = '';
  nestedId = '';
  invalidAskFirst = false;
  api = await startApiServer(0, {
    dataDir: join(root, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as (typeof calls)[number];
    calls.push(call);
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
              name: 'ask',
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
                  : 'ask',
              arguments: JSON.stringify(
                intermediate
                  ? { action: 'send_message', botId: nestedId, message: 'Check the details.' }
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
    await provider();
    await chat(main);
    await chat(child);
    expect(calls[0].messages[0].content).toContain('actual human or bot-sounding names');
    expect(calls[1].messages[0].content).toContain('"role":"Code architect"');
    expect(api.store.all('PRAGMA table_info(bots)').map((row) => row.name)).not.toContain(
      'description',
    );
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
    api.access.set('default', child.id, 'manage_bot', true);
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
  it('assigns custom tools by stable registration ID while routes remain shared', async () => {
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
    });
    const id = 'custom:' + (registration as { id: string }).id;
    expect(api.access.allowed(main, id)).toBe(true);
    expect(api.access.allowed(child, id)).toBe(false);
    api.access.set('default', child.id, id, true);
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
  it('creates children through manage_bot, bounds their grants, and retains nested creator relationships', async () => {
    const main = await bot(),
      peer = await bot('Peer');
    api.access.set('default', peer.id, 'manage_bot', false);
    await expect(api.botManagement.create(peer, input('Denied'))).rejects.toThrow(
      'not assigned manage_bot',
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
    const grandchild = await api.botManagement.create(child, input('Helper'));
    expect(grandchild.createdBy).toBe(child.id);
    expect(api.access.allowed(grandchild, 'browser')).toBe(true);
    expect(api.access.allowed(grandchild, 'memory')).toBe(false);
    expect(api.access.allowed(grandchild, 'manage_bot')).toBe(true);
    expect((await request<Bot[]>('/bots')).data).toHaveLength(4);
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
    expect(childCall.tools.map((item) => item.function.name)).toContain('manage_bot');
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
  it('propagates a nested child approval to every waiting ancestor and restores the chain', async () => {
    const main = await bot();
    await provider();
    const child = await api.botManagement.create(main, input('Ada'));
    const grandchild = await api.botManagement.create(child, input('Nova'));
    delegatedId = child.id;
    nestedId = grandchild.id;
    mode = 'delegate-nested';
    const pending = chat(main);
    await waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1),
    );
    const approval = (await request<ApprovalState>('/approvals')).data.pending[0];
    expect(approval.botId).toBe(grandchild.id);
    expect(approval.blockedParents?.map((item) => item.botId).sort()).toEqual(
      [main.id, child.id].sort(),
    );
    await restart();
    await pending;
    await waitFor(async () =>
      expect((await request(`/approvals/${approval.id}`, 'POST', { approved: false })).status).toBe(
        200,
      ),
    );
    await waitFor(async () =>
      expect((await request<ChatMessage[]>(`/bots/${main.id}/messages`)).data.at(-1)?.status).toBe(
        'complete',
      ),
    );
    expect((await request<Conversation[]>('/conversations?kind=bot')).data).toHaveLength(2);
    expect(calls).toHaveLength(6);
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
    const other = await api.botManagement.create(main, input('Nova'));
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
    const ada = await api.botManagement.create(main, input('Ada'));
    const nova = await api.botManagement.create(main, input('Nova'));
    const junior = await api.botManagement.create(ada, input('Junior'));
    const colleague = await api.botManagement.create(nova, input('Colleague'));
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
    const noTools = await api.botManagement.create(ada, input('Restricted'), []);
    expect(api.access.allowed(noTools, 'manage_bot')).toBe(false);
    await expect(
      api.botManagement.sendMessage(noTools, colleague.id, 'Denied', signal),
    ).rejects.toThrow('not assigned manage_bot');
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
