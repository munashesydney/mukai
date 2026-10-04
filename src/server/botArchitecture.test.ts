import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, root: string;
let calls: {
  model: string;
  tools: { function: { name: string } }[];
  messages: { role: string; content: string }[];
}[];
let mode: 'normal' | 'slow' | 'revoke' | 'delegate' | 'web-search' | 'web-revoke';
let delegatedId: string;
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
  api = await startApiServer(0, {
    dataDir: join(root, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as (typeof calls)[number];
    calls.push(call);
    if (mode === 'slow') return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (
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
      mode === 'delegate' &&
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
      contextWindowTokens: 65536,
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
    await vi.waitFor(() => expect(calls).toHaveLength(6));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
