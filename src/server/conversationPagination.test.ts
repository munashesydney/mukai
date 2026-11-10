import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { BotRepository } from './repositories/botRepository';
import { scoutBot } from './services/botService';
import { ConversationRepository } from './repositories/conversationRepository';
import type { Conversation, ConversationHistoryPage } from '../shared/conversations';

let api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-conversation-pages-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
  new BotRepository(api.store).create({ ...scoutBot(), id: 'child', isMain: false });
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
async function request(query: string) {
  return fetch(`${api.url}/conversations?${query}`, {
    headers: { Authorization: `Bearer ${api.token}` },
  });
}

it('pages private and bot chats with stable ties, preserving participant order and legacy arrays', async () => {
  const repository = new ConversationRepository(api.store);
  // The seed chat is not part of the history under test.
  api.store.run('DELETE FROM conversations');
  const ids = [];
  for (let i = 0; i < 27; i++) {
    const chat = repository.createBotChat('default', 'scout', 'child', `Chat ${i}`);
    api.store.run(
      "UPDATE conversations SET kind=?,updated_at='2026-11-09T12:00:00.000Z' WHERE id=?",
      i % 2 ? 'private' : 'bot',
      chat.id,
    );
    ids.push(chat.id);
  }
  repository.create('default', { name: 'Space', description: '', botIds: [] });
  const seen: Conversation[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      `workspaceId=default&kind=history&limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as ConversationHistoryPage;
    expect(page.conversations.length).toBeLessThanOrEqual(12);
    expect(page.conversations.every((chat) => chat.botIds.join('/') === 'scout/child')).toBe(true);
    seen.push(...page.conversations);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.map((chat) => chat.id)).toEqual(ids.sort().reverse());
  expect(new Set(seen.map((chat) => chat.id)).size).toBe(27);
  const legacy = await (await request('workspaceId=default&kind=bot')).json();
  expect(Array.isArray(legacy)).toBe(true);
  const spaces = (await (await request('workspaceId=default')).json()) as Conversation[];
  expect(spaces.map((chat) => chat.name)).toEqual(['Space']);
});

it('rejects invalid bounds and cross-workspace cursors and returns an exhausted empty page', async () => {
  const repository = new ConversationRepository(api.store);
  for (let i = 0; i < 3; i++) repository.createBotChat('default', 'scout', 'child', 'Test');
  const first = (await (
    await request('workspaceId=default&kind=history&limit=1')
  ).json()) as ConversationHistoryPage;
  expect(first.nextCursor).toBeTruthy();
  expect((await request(`workspaceId=other&kind=history&cursor=${first.nextCursor}`)).status).toBe(
    400,
  );
  for (const params of ['limit=0', 'limit=101', 'limit=wat', 'cursor=invalid']) {
    expect((await request(`workspaceId=default&kind=history&${params}`)).status).toBe(400);
  }
  expect((await request('workspaceId=missing&kind=history')).status).toBe(404);
  api.store.run('DELETE FROM conversations');
  const empty = (await (
    await request('workspaceId=default&kind=history')
  ).json()) as ConversationHistoryPage;
  expect(empty).toEqual({ conversations: [], nextCursor: null });
});
