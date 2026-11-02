import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { seedTestWorkspace } from './testFixtures';
import { WorkspaceRepository } from './repositories/workspaceRepository';
import type { Bot, ProviderSettings } from '../shared/ai';
import type { AIActivity } from '../shared/aiActivity';

let api: Awaited<ReturnType<typeof startApiServer>>;
let dir: string;
async function request<T>(path: string, body?: unknown) {
  const response = await fetch(api.url + path, {
    method: body ? 'PUT' : 'GET',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: (await response.json()) as T };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-global-ai-'));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestWorkspace(api.store);
});
afterEach(async () => {
  await api.shutdown();
  api.server.closeAllConnections();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  rmSync(dir, { recursive: true, force: true });
});

it('defaults to four globally, validates and persists updates, and preserves the independent pursuit limit', async () => {
  expect((await request('/limits')).data).toEqual({ aiConcurrency: 4, pursuitConcurrency: 5 });
  for (const value of [0, -1, 1.5, 51, '4'])
    expect((await request('/limits', { aiConcurrency: value })).status).toBe(400);
  expect((await request('/limits', { aiConcurrency: 2 })).data).toEqual({
    aiConcurrency: 2,
    pursuitConcurrency: 5,
  });
  expect((await request('/limits', { pursuitConcurrency: 3 })).data).toEqual({
    aiConcurrency: 2,
    pursuitConcurrency: 3,
  });
  await api.shutdown();
  api.server.closeAllConnections();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  expect((await request('/limits')).data).toEqual({ aiConcurrency: 2, pursuitConcurrency: 3 });
  expect((await request<AIActivity>('/ai-activity')).data).toMatchObject({
    limit: 2,
    running: [],
    queued: [],
  });
  expect((await fetch(api.url + '/ai-activity')).status).toBe(401);
});

it('queues actual chats across workspaces, shows their owners, cancels a queued chat, and admits the next one', async () => {
  const responses: ServerResponse[] = [];
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk;
    }
    responses.push(res);
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const finish = (res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: 'done', model: 'fixture', choices: [{ index: 0, delta: { content: 'Finished.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  };
  const posts = async <T>(path: string, body: unknown) => {
    const response = await fetch(api.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  };
  const work: Promise<string>[] = [];
  try {
    await posts<ProviderSettings>('/providers', {
      name: 'Global fixture',
      kind: 'compatible',
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      defaultModel: 'fixture',
      isDefault: true,
      supportsImages: false,
      apiKey: 'fixture',
      models: [
        {
          id: 'fixture',
          name: 'Fixture',
          contextWindowTokens: 262144,
          maxOutputTokens: 4096,
          supportsImages: false,
        },
      ],
    });
    new WorkspaceRepository(api.store).create({
      id: 'second',
      name: 'Second workspace',
      folder: null,
      computer: 'local',
      createdAt: new Date().toISOString(),
    });
    const bots: Bot[] = [];
    for (let index = 0; index < 6; index++)
      bots.push(
        await posts<Bot>('/bots', {
          name: `Bot ${index}`,
          role: 'Assistant',
          instructions: 'Answer.',
          providerId: null,
          model: null,
          supportsImages: null,
          avatar: 'nova',
          workspaceId: index % 2 ? 'second' : 'default',
        }),
      );
    for (const bot of bots)
      work.push(
        fetch(api.url + `/bots/${bot.id}/chat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: randomUUID(), text: 'Check', attachmentIds: [] }),
        }).then((response) => response.text()),
      );
    await vi.waitFor(() => expect(responses).toHaveLength(4));
    await vi.waitFor(async () =>
      expect((await request<AIActivity>('/ai-activity')).data.queued).toHaveLength(2),
    );
    const activity = (await request<AIActivity>('/ai-activity')).data;
    expect(
      [...activity.running, ...activity.queued].every(
        (item) => item.conversationId && item.messageId,
      ),
    ).toBe(true);
    expect(new Set(activity.running.map((item) => item.workspaceId))).toEqual(
      new Set(['default', 'second']),
    );
    expect(activity.running.some((item) => item.workspaceName === 'Second workspace')).toBe(true);
    const canceled = activity.queued[1];
    await posts(`/bots/${canceled.botId}/stop`, {});
    await vi.waitFor(async () =>
      expect((await request<AIActivity>('/ai-activity')).data.queued).toHaveLength(1),
    );
    expect(responses).toHaveLength(4);
    finish(responses[0]);
    await vi.waitFor(() => expect(responses).toHaveLength(5));
    expect((await request<AIActivity>('/ai-activity')).data.running).toHaveLength(4);
    responses.slice(1).forEach(finish);
    await Promise.all(work);
    expect((await request<AIActivity>('/ai-activity')).data).toMatchObject({
      running: [],
      queued: [],
    });
  } finally {
    await api.shutdown();
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    await Promise.allSettled(work);
  }
}, 20000);
