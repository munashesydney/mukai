import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { BotRepository } from './repositories/botRepository';
import { ConversationRepository } from './repositories/conversationRepository';
import { PursuitRepository } from './repositories/pursuitRepository';
import { scoutBot } from './services/botService';
import type { FailureInbox } from '../shared/failures';

let api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-failures-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
});
async function stop() {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
}
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});
async function request(path = '/failures', method = 'GET') {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token },
  });
  return { status: response.status, data: (await response.json()) as FailureInbox };
}
function chat(
  status = 'failed',
  workspaceId = 'default',
  botId = 'scout',
  kind: 'space' | 'private' | 'bot' = 'space',
) {
  const conversations = new ConversationRepository(api.store);
  const conversation =
    kind === 'private'
      ? conversations.createPrivate(workspaceId, botId)
      : conversations.create(workspaceId, {
          name: 'Export report',
          description: '',
          botIds: [botId],
        });
  if (kind === 'bot')
    api.store.run("UPDATE conversations SET kind='bot' WHERE id=?", conversation.id);
  const requestId = randomUUID(),
    messageId = randomUUID(),
    now = new Date().toISOString();
  api.store.run(
    "INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at) VALUES(?,?,?,?, 'user','Export records','complete',?)",
    randomUUID(),
    conversation.id,
    kind === 'bot' ? botId : null,
    requestId,
    now,
  );
  api.store.run(
    "INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at,error,finished_at) VALUES(?,?,?,?, 'assistant','Saved progress',?,?,?,?)",
    messageId,
    conversation.id,
    botId,
    requestId,
    status,
    now,
    'Provider disconnected',
    now,
  );
  return { conversation, messageId, requestId };
}
function otherWorkspace() {
  api.store.run(
    "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other','Other workspace',NULL,?)",
    new Date().toISOString(),
  );
  new BotRepository(api.store).create({ ...scoutBot(), id: 'other-bot', workspaceId: 'other' });
}
describe('global Failed inbox', () => {
  it('includes private, space, bot and pursuit failures across workspaces, excluding stops and work still running', async () => {
    const first = chat('failed', 'default', 'scout', 'private');
    const space = chat('interrupted');
    const pair = chat('failed', 'default', 'scout', 'bot');
    chat('stopped');
    chat('complete');
    chat('streaming');
    otherWorkspace();
    const other = chat('failed', 'other', 'other-bot');
    const pursuits = new PursuitRepository(api.store);
    const pursuit = pursuits.create(
      'other',
      'other-bot',
      {
        name: 'Scheduled review',
        objective: 'Review',
        successCriteria: 'Verified',
        firstRunAt: new Date(Date.now() + 3600000).toISOString(),
        deadline: null,
      },
      Date.now(),
    );
    const run = pursuits.claim(pursuit.id, 'manual', Date.now())!;
    pursuits.finish(
      run.id,
      'failed',
      'No response',
      'Provider unavailable',
      'waiting_for_you',
      Date.now(),
    );
    const inbox = (await request()).data;
    expect(inbox.total).toBe(5);
    expect(new Set(inbox.items.map((item) => item.id))).toEqual(
      new Set([
        first.conversation.id,
        space.conversation.id,
        pair.conversation.id,
        other.conversation.id,
        run.conversationId,
      ]),
    );
    expect(inbox.items.find((item) => item.id === run.conversationId)).toMatchObject({
      workspaceId: 'other',
      workspaceName: 'Other workspace',
      runId: run.id,
      pursuitId: pursuit.id,
    });
    expect(
      inbox.items.find((item) => item.id === first.conversation.id)?.conversation.ownerBotId,
    ).toBe('scout');
    await request('/failures/' + run.conversationId, 'DELETE');
    expect((await request()).data.total).toBe(4);
    expect(pursuits.retry(run.id)?.status).toBe('running');
    expect((await request()).data.total).toBe(4);
    pursuits.finish(run.id, 'failed', 'Saved work', 'Retry failed', 'waiting_for_you', Date.now());
    expect((await request()).data.total).toBe(5);
  });
  it('dismisses one or all pages globally, persists dismissal after restart, and preserves chats and work', async () => {
    const one = chat();
    otherWorkspace();
    chat('failed', 'other', 'other-bot');
    for (let i = 0; i < 32; i++) chat('interrupted');
    const messages = api.store.all('SELECT * FROM messages'),
      conversations = api.store.all('SELECT * FROM conversations');
    expect((await request()).data).toMatchObject({ total: 34 });
    expect((await request()).data.items).toHaveLength(30);
    expect((await request('/failures?offset=30')).data.items).toHaveLength(4);
    expect((await request('/failures/' + one.conversation.id, 'DELETE')).status).toBe(200);
    expect((await request()).data.total).toBe(33);
    await stop();
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request()).data.total).toBe(33);
    expect((await request('/failures', 'DELETE')).status).toBe(200);
    expect((await request()).data).toEqual({ total: 0, items: [] });
    expect(api.store.all('SELECT * FROM messages')).toEqual(messages);
    expect(api.store.all('SELECT * FROM conversations')).toEqual(conversations);
  });
  it('shows a dismissed failure again if the same response fails after a retry, and hides recovery and success', async () => {
    const c = chat();
    await request('/failures/' + c.conversation.id, 'DELETE');
    expect((await request()).data.total).toBe(0);
    api.store.run("UPDATE messages SET status='streaming' WHERE id=?", c.messageId);
    expect((await request()).data.total).toBe(0);
    api.store.run("UPDATE messages SET status='failed' WHERE id=?", c.messageId);
    expect((await request()).data.total).toBe(1);
    api.store.run("UPDATE messages SET status='complete' WHERE id=?", c.messageId);
    expect((await request()).data.total).toBe(0);
  });
  it('ignores obsolete failures after a newer message and clears dismissals on new responses', async () => {
    const c = chat();
    await request('/failures/' + c.conversation.id, 'DELETE');
    const requestId = randomUUID(),
      now = new Date().toISOString();
    api.store.run(
      "INSERT INTO messages(id,conversation_id,request_id,role,content,status,created_at) VALUES(?,?,?,'user','New request','complete',?)",
      randomUUID(),
      c.conversation.id,
      requestId,
      now,
    );
    expect((await request()).data.total).toBe(0);
    const id = randomUUID();
    api.store.run(
      "INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at) VALUES(?,?,'scout',?,'assistant','','streaming',?)",
      id,
      c.conversation.id,
      requestId,
      now,
    );
    api.store.run("UPDATE messages SET status='failed' WHERE id=?", id);
    expect((await request()).data.total).toBe(1);
    await request('/failures/' + c.conversation.id, 'DELETE');
    api.store.run('DELETE FROM conversations WHERE id=?', c.conversation.id);
    expect(api.store.all('SELECT * FROM chat_failure_dismissals')).toEqual([]);
  });
  it('requires owner authentication and validates offsets and dismissal targets', async () => {
    expect((await fetch(api.url + '/failures')).status).toBe(401);
    expect((await request('/failures?offset=-1')).status).toBe(400);
    expect((await request('/failures/missing', 'DELETE')).status).toBe(404);
  });
});
