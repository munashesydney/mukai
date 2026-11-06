import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDetail, TrajectoryRecord } from '../shared/trajectory';
import { startApiServer } from './app';
import { ConversationRepository } from './repositories/conversationRepository';
import { TrajectoryRepository } from './repositories/trajectoryRepository';
import { seedTestBot } from './testFixtures';

let directory: string;
let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
let provider: ReturnType<typeof createServer> | undefined;

async function stopApi() {
  if (!api) return;
  const app = api;
  api = undefined;
  await app.shutdown();
  app.server.closeAllConnections();
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  app.dispose();
}

afterEach(async () => {
  await stopApi();
  if (provider) {
    const server = provider;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    provider = undefined;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function request(path: string, body?: unknown) {
  return fetch(api!.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${api!.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

it('keeps failed provider attempts and redacted request detail after the chat checkpoint is removed', async () => {
  directory = mkdtempSync(join(tmpdir(), 'mukai-trajectory-'));
  const secret = 'trajectory-test-provider-key';
  let attempts = 0;
  let sentSystem = '';
  let sentRuntime = '';
  provider = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    if (++attempts === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Temporary failure with ${secret}` } }));
      return;
    }
    const body = JSON.parse(input) as { messages: { role: string; content: string }[] };
    sentSystem = body.messages.find((message) => message.role === 'system')?.content || '';
    sentRuntime = body.messages.at(-1)?.content || '';
    const chunk = {
      id: 'fixture',
      model: 'trace-model',
      object: 'chat.completion.chunk',
      created: 1,
      choices: [{ index: 0, delta: { content: `Reply with ${secret}.` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131 },
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  api = await startApiServer(0, { dataDir: directory });
  seedTestBot(api.store);
  api.store.run("UPDATE workspaces SET memory_enabled=0 WHERE id='default'");
  const secondConversation = new ConversationRepository(api.store).createPrivate(
    'default',
    'scout',
    randomUUID(),
  );
  expect(
    (
      await request('/providers', {
        name: 'Trajectory fixture',
        kind: 'compatible',
        defaultModel: 'trace-model',
        apiKey: secret,
        supportsImages: false,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        isDefault: true,
      })
    ).status,
  ).toBe(201);
  const path = '/conversations/bot-scout/trajectory';
  expect(await (await request(path)).json()).toEqual([]);

  const response = await request('/bots/scout/chat', {
    requestId: randomUUID(),
    text: 'Say hello.',
    attachmentIds: [],
  });
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.at(-1)?.type).toBe('done');
  expect(api.store.all('SELECT * FROM chat_jobs')).toEqual([]);
  const records = (await (await request(path)).json()) as TrajectoryRecord[];
  expect(records).toHaveLength(2);
  const [failed, complete] = records;
  expect(failed).toMatchObject({ kind: 'model', status: 'failed', finishedAt: expect.any(Number) });
  expect(complete).toMatchObject({
    kind: 'model',
    status: 'complete',
    firstTokenAt: expect.any(Number),
    usage: { input: 123, output: 8 },
    preview: 'Reply with [redacted].',
  });
  expect(JSON.stringify(records)).not.toContain(secret);
  const detailPath = `${path}?record=${complete.id}`;
  const detail = (await (await request(detailPath)).json()) as TrajectoryDetail;
  expect(detail).toMatchObject({
    system: sentSystem.replace('workspace Bearer access', 'workspace Bearer [redacted]'),
    context: [sentRuntime],
    output: 'Reply with [redacted].',
  });
  expect(await (await request(`${path}?record=${failed.id}`)).json()).toMatchObject({
    error: expect.stringContaining('HTTP 500'),
  });
  expect(
    (await request(`/conversations/${secondConversation.id}/trajectory?record=${complete.id}`))
      .status,
  ).toBe(404);
  expect((await fetch(api.url + detailPath)).status).toBe(401);

  const abandoned = new TrajectoryRepository(api.store).start(
    complete.messageId,
    {
      kind: 'tool',
      title: 'Unfinished fixture tool',
      status: 'running',
      startedAt: Date.now(),
    },
    {},
  );
  await stopApi();
  api = await startApiServer(0, { dataDir: directory });
  expect(await (await request(detailPath)).json()).toEqual(detail);
  expect(await (await request(path)).json()).toEqual([
    ...records,
    expect.objectContaining({ id: abandoned, status: 'interrupted' }),
  ]);
});
