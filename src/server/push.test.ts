import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { ConversationRepository } from './repositories/conversationRepository';
import { PushRepository } from './repositories/pushRepository';
import { relayOrigin } from './push/transport';

let api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
let deliveries: {
  origin: string;
  id: string;
  credential: string;
  payload: Record<string, string>;
}[];
let deliveryStatus = 200;
const token = 'a'.repeat(64),
  deliveryToken = 'b'.repeat(43);
const sessionHash = createHash('sha256')
  .update('mukai-device:' + token)
  .digest('hex');
let installationId: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-push-'));
  deliveries = [];
  deliveryStatus = 200;
  api = await startApiServer(0, {
    dataDir: dir,
    memoryExtractor: async () => ({ facts: [] }),
    pushSender: async (origin, id, credential, payload) => {
      deliveries.push({ origin, id, credential, payload });
      return deliveryStatus;
    },
  });
  seedTestBot(api.store);
  api.store.run('INSERT INTO web_sessions VALUES(?,?)', sessionHash, Date.now() + 86400000);
  installationId = randomUUID();
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
async function request(path: string, method = 'GET', body?: unknown, session = token) {
  const response = await fetch(api.url + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + api.token,
      'X-Mukai-Session': session,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function register() {
  const result = await request('/push/devices', 'POST', {
    installationId,
    relayUrl: 'https://relay.example',
    deliveryToken,
  });
  expect(result.status).toBe(200);
}
function message(kind: 'private' | 'bot' = 'private', initial = 'streaming') {
  const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
  if (kind === 'bot')
    api.store.run("UPDATE conversations SET kind='bot' WHERE id=?", conversation.id);
  const id = randomUUID();
  api.store.run(
    "INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at) VALUES(?,?,? ,?,'assistant','secret conversation body',?,?)",
    id,
    conversation.id,
    'scout',
    randomUUID(),
    initial,
    new Date().toISOString(),
  );
  return { id, conversation };
}
function complete(id: string) {
  api.store.run("UPDATE messages SET status='complete' WHERE id=?", id);
}

describe('mobile push backend', () => {
  it('requires a real device session, validates relay origins and encrypts delivery credentials', async () => {
    const body = { installationId, relayUrl: 'https://relay.example', deliveryToken };
    expect((await request('/push/devices', 'POST', body, '')).status).toBe(401);
    expect((await request('/push/devices', 'POST', body, 'c'.repeat(64))).status).toBe(401);
    for (const relayUrl of [
      'http://relay.example',
      'https://127.0.0.1',
      'https://relay.example/path',
      'https://user:pass@relay.example',
    ])
      expect((await request('/push/devices', 'POST', { ...body, relayUrl })).status).toBe(400);
    await register();
    const row = api.store.get('SELECT credential FROM mobile_push_devices')!;
    expect(row.credential).not.toContain(deliveryToken);
    expect(new PushRepository(api.store).credential(String(row.credential))).toBe(deliveryToken);
    const config = (await request('/push/config')).data;
    expect(config.serverId).toMatch(/^[a-f0-9]{48}$/);
    expect(config).not.toHaveProperty('deliveryToken');
  });
  it('queues new completed replies once, skips historical and bot-to-bot messages, forwards only IDs', async () => {
    const old = message('private', 'complete');
    await register();
    await api.push.flush();
    expect(deliveries).toHaveLength(0);
    const pending = message();
    complete(pending.id);
    complete(pending.id);
    complete(old.id);
    const internal = message('bot');
    complete(internal.id);
    await api.push.flush();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      origin: 'https://relay.example',
      id: installationId,
      credential: deliveryToken,
      payload: {
        kind: 'response-complete',
        conversationId: pending.conversation.id,
        botId: 'scout',
        workspaceId: 'default',
      },
    });
    expect(JSON.stringify(deliveries)).not.toContain('secret conversation body');
    await api.push.flush();
    expect(deliveries).toHaveLength(1);
  });
  it('queues approval requests once and bot notification updates', async () => {
    await register();
    const m = message();
    const approvalId = randomUUID();
    const save = () =>
      api.store.run(
        'INSERT OR REPLACE INTO pending_tool_approvals VALUES(?,?,?)',
        approvalId,
        m.id,
        JSON.stringify({ id: approvalId }),
      );
    save();
    save();
    api.store.run(
      'INSERT INTO bot_notifications(id,workspace_id,bot_id,bot_name,title,message,source_conversation_id,source_message_id,tool_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      randomUUID(),
      'default',
      'scout',
      'Scout',
      'Secret title',
      'Secret update',
      m.conversation.id,
      m.id,
      'tool-1',
      new Date().toISOString(),
    );
    await api.push.flush();
    expect(deliveries.map((x) => x.payload.kind).sort()).toEqual(['approval-required', 'update']);
    expect(JSON.stringify(deliveries)).not.toContain('Secret');
  });
  it('retries transient failures and removes permanently revoked devices', async () => {
    await register();
    const m = message();
    complete(m.id);
    deliveryStatus = 503;
    await api.push.flush();
    expect(api.store.get('SELECT status,attempts FROM mobile_push_outbox')).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    await api.push.flush();
    expect(deliveries).toHaveLength(1);
    api.store.run('UPDATE mobile_push_outbox SET next_at=0');
    deliveryStatus = 410;
    await api.push.flush();
    expect(api.store.all('SELECT * FROM mobile_push_devices')).toHaveLength(0);
    expect(api.store.all('SELECT * FROM mobile_push_outbox')).toHaveLength(0);
  });
  it('revoking or expiring a signed-in session prevents future delivery', async () => {
    await register();
    const m = message();
    complete(m.id);
    api.store.run('UPDATE web_sessions SET expires_at=0');
    await api.push.flush();
    expect(deliveries).toHaveLength(0);
    expect(api.store.all('SELECT * FROM mobile_push_devices')).toHaveLength(0);
  });
  it('test push targets the signed-in phone and device deletion is idempotent', async () => {
    await register();
    message();
    expect((await request('/push/test', 'POST')).status).toBe(200);
    await api.push.flush();
    expect(deliveries[0].payload.kind).toBe('test');
    expect((await request('/push/devices/' + installationId, 'DELETE')).status).toBe(200);
    expect((await request('/push/devices/' + installationId, 'DELETE')).status).toBe(200);
  });
  it('accepts the real mobile session through the served /api endpoint without an owner API bearer', async () => {
    const webDir = join(dir, 'web');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<html>Mukai</html>');
    const mobileApi = await startApiServer(0, { dataDir: join(dir, 'mobile-data'), webDir });
    try {
      mobileApi.store.run(
        'INSERT INTO web_sessions VALUES(?,?)',
        sessionHash,
        Date.now() + 86400000,
      );
      const response = await fetch(mobileApi.url + '/api/push/devices', {
        method: 'POST',
        headers: { 'X-Mukai-Session': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId, relayUrl: 'https://relay.example', deliveryToken }),
      });
      expect(response.status).toBe(200);
      mobileApi.store.run('DELETE FROM web_sessions WHERE token_hash=?', sessionHash);
      expect(mobileApi.store.all('SELECT * FROM mobile_push_devices')).toHaveLength(0);
      const denied = await fetch(mobileApi.url + '/api/push/config', {
        headers: { 'X-Mukai-Session': token },
      });
      expect(denied.status).toBe(401);
    } finally {
      await mobileApi.shutdown();
      await new Promise<void>((resolve) => mobileApi.server.close(() => resolve()));
    }
  });
  it('rejects local relay destinations before any connection', () => {
    for (const value of [
      'https://localhost',
      'https://10.0.0.1',
      'https://[::1]',
      'https://169.254.169.254',
      'https://relay.example/?token=x',
    ])
      expect(() => relayOrigin(value)).toThrow();
  });
});
