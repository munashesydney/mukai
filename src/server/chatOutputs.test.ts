import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { ConversationRepository } from './repositories/conversationRepository';
import type { ChatServerOutput } from '../shared/chatActivity';
import { executeRuntime } from './tools/runtimeContext';
let api: Awaited<ReturnType<typeof startApiServer>>,
  dir: string,
  conversationId: string,
  messageId: string;
async function request(path: string, value?: unknown) {
  const response = await fetch(api.url + path, {
    method: value ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: value ? JSON.stringify(value) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-chat-outputs-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
  conversationId = new ConversationRepository(api.store).createPrivate('default', 'scout').id;
  messageId = randomUUID();
  api.store.run(
    "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id) VALUES(?,'scout',?,'assistant','Done','complete','now',?)",
    messageId,
    randomUUID(),
    conversationId,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  api.server.closeAllConnections();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  if (!dir.startsWith(join(tmpdir(), 'mukai-chat-outputs-')))
    throw new Error('Unexpected test folder');
  rmSync(dir, { recursive: true, force: true });
});
it('discovers late process output, isolates conversations, and retains links when the runtime ends', async () => {
  const sessionId = randomUUID();
  let log = '';
  const read = vi.spyOn(api.processes, 'read').mockImplementation((owner, id) => ({
    ...owner,
    id,
    command: '',
    cwd: '',
    pid: 1,
    status: 'running',
    exitCode: null,
    createdAt: '',
    output: log,
    nextOffset: log.length,
    truncated: false,
  }));
  api.store.run(
    'UPDATE messages SET activity_json=? WHERE id=?',
    JSON.stringify([
      {
        id: 'run',
        tool: 'terminal',
        action: 'run',
        status: 'complete',
        path: 'npm run dev',
        summary: '',
        processSessionId: sessionId,
      },
    ]),
    messageId,
  );
  expect((await request(`/conversations/${conversationId}/outputs`)).data).toEqual([]);
  log = 'Ready: http://0.0.0.0:3001/';
  const outputs = (await request(`/conversations/${conversationId}/outputs`))
    .data as ChatServerOutput[];
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({
    url: 'http://localhost:3001/',
    status: 'running',
    messageId,
    sessionId,
    computer: 'local',
  });
  expect(read).toHaveBeenCalledWith(
    { workspaceId: 'default', botId: 'scout', conversationId },
    sessionId,
  );
  const other = new ConversationRepository(api.store).createPrivate('default', 'scout');
  expect((await request(`/conversations/${other.id}/outputs`)).data).toEqual([]);
  expect(
    (await request(`/conversations/${other.id}/open-output`, { outputId: outputs[0].id })).status,
  ).toBe(404);
  const open = vi.spyOn(api.browsers, 'execute').mockResolvedValue({ tab: { id: 'tab' } });
  expect(
    (await request(`/conversations/${conversationId}/open-output`, { outputId: outputs[0].id }))
      .data,
  ).toEqual({ guest: false, tab: { id: 'tab' } });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId }),
    { action: 'open', target: 'mukai', url: 'http://localhost:3001/' },
    expect.any(AbortSignal),
  );
  read.mockImplementation(() => {
    throw new Error('Runtime restarted');
  });
  expect((await request(`/conversations/${conversationId}/outputs`)).data).toMatchObject([
    { id: outputs[0].id, status: 'unavailable' },
  ]);
  expect((await request(`/conversations/${conversationId}/outputs`)).data).toHaveLength(1);
  api.store.run('UPDATE messages SET activity_json=? WHERE id=?', '[]', messageId);
  expect((await request(`/conversations/${conversationId}/outputs`)).data).toMatchObject([
    { id: outputs[0].id, status: 'unavailable' },
  ]);
});
it('records URLs beyond the truncated tool preview and validates structured output addresses', async () => {
  vi.spyOn(api.processes, 'read').mockImplementation(() => {
    throw new Error('Runtime ended');
  });
  await executeRuntime(
    {
      owner: { workspaceId: 'default', botId: 'scout', conversationId },
      signal: new AbortController().signal,
      budget: { remaining: 10 },
      onActivity(activity) {
        api.store.run(
          'UPDATE messages SET activity_json=? WHERE id=?',
          JSON.stringify([activity]),
          messageId,
        );
      },
    },
    'run',
    'terminal',
    'run',
    'node server.cjs',
    () => ({
      id: randomUUID(),
      status: 'running',
      output: 'x'.repeat(14000) + '\nhttp://localhost:80/',
    }),
  );
  const output = (await request(`/conversations/${conversationId}/outputs`))
    .data as ChatServerOutput[];
  expect(output).toMatchObject([{ url: 'http://localhost/', status: 'unavailable' }]);
  api.store.run(
    'UPDATE messages SET activity_json=? WHERE id=?',
    JSON.stringify([
      {
        id: 'fake',
        tool: 'terminal',
        action: 'run',
        status: 'complete',
        summary: '',
        processSessionId: randomUUID(),
        serverUrls: ['https://example.com:3000/', 'javascript:alert(1)'],
      },
    ]),
    messageId,
  );
  expect((await request(`/conversations/${conversationId}/outputs`)).data).toHaveLength(1);
});
it('opens VM outputs in the guest and never starts a stopped VM while refreshing', async () => {
  api.store.run("UPDATE workspaces SET computer='qemu' WHERE id='default'");
  const sessionId = randomUUID();
  api.store.run(
    'UPDATE messages SET activity_json=? WHERE id=?',
    JSON.stringify([
      {
        id: 'run',
        tool: 'terminal',
        action: 'run',
        status: 'complete',
        path: '',
        summary: '',
        processSessionId: sessionId,
        serverUrls: ['http://localhost:5173/'],
      },
    ]),
    messageId,
  );
  const status = vi
    .spyOn(api.computers, 'status')
    .mockReturnValue({ kind: 'qemu', state: 'stopped' });
  const guestRequest = vi
    .fn()
    .mockResolvedValue({ id: sessionId, status: 'running', output: 'http://localhost:5173/' });
  const guest = vi
    .spyOn(api.computers, 'guest')
    .mockReturnValue({ request: guestRequest } as never);
  const output = (await request(`/conversations/${conversationId}/outputs`))
    .data[0] as ChatServerOutput;
  expect(output.status).toBe('unavailable');
  expect(guest).not.toHaveBeenCalled();
  expect(
    (await request(`/conversations/${conversationId}/open-output`, { outputId: output.id })).status,
  ).toBe(409);
  status.mockReturnValue({ kind: 'qemu', state: 'running' });
  expect(
    (await request(`/conversations/${conversationId}/open-output`, { outputId: output.id })).data,
  ).toEqual({ guest: true });
  expect(guestRequest).toHaveBeenCalledWith(
    'browser',
    { action: 'open', target: 'chrome', url: output.url },
    expect.objectContaining({ conversationId }),
    expect.any(AbortSignal),
  );
});
