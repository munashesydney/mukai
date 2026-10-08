import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { scoutBot } from './services/botService';
import { ConversationRepository } from './repositories/conversationRepository';
import { communicateTools } from './tools/communicate/execute';
import { communicateDefinition } from './tools/communicate/definition';
import { conversationsDefinition } from './tools/conversations/definition';
import type { Conversation } from '../shared/conversations';
import type { ChatMessage, ToolInfo } from '../shared/ai';
import type { NotificationInbox } from '../shared/notifications';

let api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-notifications-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  expect(dir.startsWith(join(tmpdir(), 'mukai-notifications-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
async function request<T>(path: string, method = 'GET') {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token },
  });
  return { status: response.status, data: (await response.json()) as T };
}
function message(conversationId: string, content = 'Verified a useful result', role = 'assistant') {
  const id = randomUUID();
  api.store.run(
    `INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at,author_name)
     VALUES(?,?,'scout',?,?,?,'complete',?,'Scout')`,
    id,
    conversationId,
    randomUUID(),
    role,
    content,
    '2026-10-07T12:00:00Z',
  );
  return id;
}
const query = (input: object, workspaceId = 'default') =>
  api.conversationHistory.execute(workspaceId, conversationsDefinition.inputSchema.parse(input));

describe('Autonomous updates and conversation history', () => {
  it('notifies without waiting, deduplicates retries, and continues as the bot’s first message', async () => {
    const source = message('bot-scout');
    const ask = vi.fn();
    const tools = communicateTools({
      ask,
      signal: new AbortController().signal,
      onActivity: () => {},
      notify: (input, callId) => api.notifications.notify(scoutBot(), source, callId, input),
    });
    const input = {
      action: 'notify' as const,
      title: 'Export is ready',
      message: 'The **export** passed validation. You can review it now.',
    };
    const options = { toolCallId: 'notify-1', messages: [], context: {} };
    await tools.communicate.execute!(input, options);
    await tools.communicate.execute!(input, options);
    expect(ask).not.toHaveBeenCalled();
    const inbox = await request<NotificationInbox>('/notifications');
    expect(inbox.data).toMatchObject({ total: 1, unread: 1 });
    const notification = inbox.data.items[0];
    expect(notification).toMatchObject({
      botId: 'scout',
      sourceConversationId: 'bot-scout',
      message: input.message,
    });
    const first = await request<Conversation>(`/notifications/${notification.id}/continue`, 'POST');
    const second = await request<Conversation>(
      `/notifications/${notification.id}/continue`,
      'POST',
    );
    expect(first.status).toBe(200);
    expect(first.data.id).toBe(second.data.id);
    expect(first.data.id).not.toBe('bot-scout');
    expect(first.data).toMatchObject({ kind: 'private', ownerBotId: 'scout', name: input.title });
    const history = await request<ChatMessage[]>(`/conversations/${first.data.id}/messages`);
    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({
      role: 'assistant',
      content: input.message,
      status: 'complete',
    });
    expect((await request<NotificationInbox>('/notifications')).data.unread).toBe(0);
    expect((await request(`/notifications/${notification.id}/dismiss`, 'POST')).status).toBe(200);
    expect((await request<NotificationInbox>('/notifications')).data.total).toBe(0);
    expect(
      (await request<ChatMessage[]>(`/conversations/${first.data.id}/messages`)).data,
    ).toHaveLength(1);
  });

  it('persists notifications across restart and refuses workspace/source spoofing', async () => {
    const source = message('bot-scout');
    const { notificationId } = api.notifications.notify(scoutBot(), source, '1', {
      title: 'Update',
      message: 'Verified finding.',
    });
    expect(() =>
      api.notifications.notify({ ...scoutBot(), workspaceId: 'wrong' }, source, '2', {
        title: 'X',
        message: 'X',
      }),
    ).toThrow();
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other','Other',NULL,?)",
      new Date().toISOString(),
    );
    expect(
      (await request(`/notifications/${notificationId}/continue?workspaceId=other`, 'POST')).status,
    ).toBe(404);
    expect((await request<NotificationInbox>('/notifications?workspaceId=other')).data.total).toBe(
      0,
    );
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<NotificationInbox>('/notifications')).data.items[0].id).toBe(
      notificationId,
    );
  });

  it('filters all four conversation kinds and searches/paginates matching messages', () => {
    const repository = new ConversationRepository(api.store);
    const chats = [repository.find('bot-scout')!];
    for (const kind of ['bot', 'pursuit_run', 'space'] as const) {
      const conversation = repository.create('default', {
        name: 'Thread ' + kind,
        description: '',
        botIds: ['scout'],
      });
      api.store.run('UPDATE conversations SET kind=? WHERE id=?', kind, conversation.id);
      chats.push({ ...conversation, kind });
    }
    for (const chat of chats) {
      message(chat.id, 'First finding: 100%_ literal');
      message(chat.id, 'Second finding', 'user');
      message(chat.id, 'Other text');
      expect(query({ action: 'search', kind: chat.kind, query: 'finding' }).results).toHaveLength(
        1,
      );
    }
    const first = query({
      action: 'search_messages',
      query: 'finding',
      conversationId: chats[1].id,
      role: 'assistant',
      botId: 'scout',
      limit: 1,
    });
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({
      kind: 'bot',
      role: 'assistant',
      content: 'First finding: 100%_ literal',
    });
    expect(query({ action: 'search_messages', query: '100%_' }).results).toHaveLength(4);
    expect(
      query({ action: 'search_messages', query: 'finding', after: '2026-10-08T00:00:00Z' }).results,
    ).toHaveLength(0);
    const read = query({ action: 'read', conversationId: chats[0].id, limit: 2 });
    expect(read.results).toHaveLength(2);
    expect(read.nextOffset).toBe(2);
    expect(
      query({ action: 'read', conversationId: chats[0].id, limit: 2, offset: read.nextOffset! })
        .results,
    ).toHaveLength(1);
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other','Other',NULL,?)",
      new Date().toISOString(),
    );
    const other = repository.create('other', {
      name: 'Secret finding',
      description: '',
      botIds: [],
    });
    message(other.id, 'Private finding');
    expect(query({ action: 'search', query: 'Secret finding' }).results).toHaveLength(0);
    expect(() => query({ action: 'read', conversationId: other.id })).toThrow(
      'Conversation not found',
    );
  });

  it('preserves clarification/approval validation and exposes both new families without a folder', async () => {
    expect(z.toJSONSchema(communicateDefinition.inputSchema).type).toBe('object');
    expect(z.toJSONSchema(conversationsDefinition.inputSchema).type).toBe('object');
    expect(
      communicateDefinition.inputSchema.safeParse({ action: 'approval', question: 'Publish?' })
        .success,
    ).toBe(true);
    expect(
      communicateDefinition.inputSchema.safeParse({
        action: 'clarification',
        question: 'Which?',
        options: [
          { label: 'A', recommended: true },
          { label: 'B', recommended: false },
        ],
      }).success,
    ).toBe(true);
    for (const input of [
      { action: 'notify', title: '', message: 'X' },
      { action: 'notify', title: 'X', message: 'X', question: 'Wait?' },
      { action: 'clarification', question: 'Which?' },
    ])
      expect(communicateDefinition.inputSchema.safeParse(input).success).toBe(false);
    const catalog = (await request<ToolInfo[]>('/tools')).data;
    expect(catalog.find((tool) => tool.id === 'communicate')).toMatchObject({
      available: true,
      actions: ['clarification', 'approval', 'notify'],
    });
    expect(catalog.find((tool) => tool.id === 'conversations')).toMatchObject({
      available: true,
      actions: ['search', 'search_messages', 'read'],
    });
    expect(catalog.some((tool) => tool.id === 'ask')).toBe(false);
  });
  it('finds matches beyond the first excerpt and reads long messages without losing text', () => {
    const content = 'a'.repeat(15000) + 'needle' + 'z'.repeat(1000);
    const id = message('bot-scout', content);
    const match = query({ action: 'search_messages', query: 'needle' });
    expect(match.results[0]).toMatchObject({
      id,
      content: expect.stringContaining('needle'),
      truncated: true,
    });
    const first = query({ action: 'read', conversationId: 'bot-scout', messageId: id, limit: 1 });
    expect(first.results[0]).toMatchObject({ contentOffset: 0, nextContentOffset: 12000 });
    const next = query({
      action: 'read',
      conversationId: 'bot-scout',
      messageId: id,
      contentOffset: 12000,
      limit: 1,
    });
    expect(next.results[0]).toMatchObject({
      content: content.slice(12000),
      nextContentOffset: null,
      truncated: false,
    });
  });
});
