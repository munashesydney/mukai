import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { PursuitRepository } from './repositories/pursuitRepository';
import {
  nextScheduledWake,
  type Pursuit,
  type PursuitDetail,
  type PursuitRun,
  type PursuitInput,
} from '../shared/pursuits';
import type { Bot, ChatMessage, ToolInfo } from '../shared/ai';
import { pursuitActionSchema, pursuitDefinition } from './tools/pursuits/definition';
import { z } from 'zod';

let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, dir: string;
let mode:
  'create' | 'waiting' | 'completed' | 'blocked' | 'waiting_for_you' | 'no-report' | 'slow' =
  'create';
let calls: { messages: { role: string; content: unknown }[] }[] = [];
const input: PursuitInput = {
  name: 'Review the notes',
  objective: 'Read notes and identify a useful next step.',
  successCriteria: 'A verified next step with supporting evidence.',
  intervalMinutes: 1,
  firstRunAt: null,
  deadline: null,
};
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function request<T>(path: string, method = 'GET', value?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { response, data: (await response.json()) as T };
}
async function createWithAI() {
  mode = 'create';
  const response = await fetch(api.url + '/bots/scout/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: randomUUID(),
      text: 'Create a scheduled pursuit to review notes.',
      attachmentIds: [],
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  const list = (await request<Pursuit[]>('/pursuits')).data;
  expect(list).toHaveLength(1);
  return list[0];
}
async function settled(id: string) {
  await vi.waitFor(() => expect(api.pursuits.detail(id).runs[0].status).not.toBe('running'), {
    timeout: 5000,
  });
  return api.pursuits.detail(id);
}
beforeEach(async () => {
  mode = 'create';
  calls = [];
  dir = mkdtempSync(join(tmpdir(), 'mukai-pursuit-test-'));
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    // Exercise the provider's schema boundary, not only execution of tool calls.
    if (
      body.tools?.some(
        (entry: { function: { parameters: { type?: string; anyOf?: unknown } } }) =>
          entry.function.parameters.type !== 'object' || entry.function.parameters.anyOf,
      )
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'Tool parameters must have an object root.',
            type: 'invalid_request_error',
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'pursuit-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (mode === 'slow') {
      send({ role: 'assistant', content: 'Working…' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        res.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (res.destroyed) return;
    }
    const hasTool = body.messages.some((m: { role: string }) => m.role === 'tool');
    if (!hasTool && mode !== 'no-report' && mode !== 'slow') {
      const name = mode === 'create' ? 'manage_pursuit' : 'report_pursuit';
      const args =
        mode === 'create'
          ? { action: 'create', ...input }
          : { status: mode, summary: 'Verified the notes. Recorded evidence and the next step.' };
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-' + randomUUID(),
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'Reviewed the notes and saved the outcome.' });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed');
  api = await startApiServer(0, { dataDir: dir });
  await request('/providers', 'POST', {
    name: 'Fixture',
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    defaultModel: 'test',
    supportsImages: false,
    isDefault: true,
    apiKey: 'test-only',
  });
});
afterEach(async () => {
  if (api) {
    await api.shutdown();
    await close(api.server);
  }
  if (fixture) await close(fixture);
  if (dir) {
    expect(dir.startsWith(join(tmpdir(), 'mukai-pursuit-test-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
describe('AI-owned pursuits and scheduled runs', () => {
  it('publishes an object tool schema while validating required fields for each action', () => {
    const schema = z.toJSONSchema(pursuitDefinition.inputSchema);
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(pursuitActionSchema.safeParse({ action: 'create' }).success).toBe(false);
    expect(pursuitActionSchema.safeParse({ action: 'update', ...input }).success).toBe(false);
    for (const action of ['pause', 'resume', 'complete']) {
      expect(pursuitActionSchema.safeParse({ action }).success).toBe(false);
    }
    expect(pursuitActionSchema.parse({ action: 'list' })).toEqual({ action: 'list' });
    const required = {
      name: input.name,
      objective: input.objective,
      successCriteria: input.successCriteria,
      intervalMinutes: input.intervalMinutes,
    };
    expect(pursuitActionSchema.parse({ action: 'create', ...required })).toMatchObject({
      firstRunAt: null,
      deadline: null,
    });
  });
  it('creates only through an AI tool, binds ownership, and blocks another bot from managing it', async () => {
    const p = await createWithAI();
    expect(p).toMatchObject({
      ownerBotId: 'scout',
      status: 'active',
      intervalMinutes: 1,
      objective: input.objective,
      successCriteria: input.successCriteria,
    });
    expect((await request('/pursuits', 'POST', input)).response.status).toBe(405);
    const tools = (await request<ToolInfo[]>('/tools')).data;
    expect(tools.find((tool) => tool.id === 'manage_pursuit')).toMatchObject({
      available: true,
      counts: { create: 1 },
    });
    const other = (
      await request<Bot>('/bots', 'POST', {
        name: 'Other',
        description: '',
        instructions: 'Help.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'atlas',
      })
    ).data;
    expect(() => api.pursuits.controlOwned(other, p.id, 'paused')).toThrow('Only the creating bot');
    expect((await request<Pursuit[]>('/pursuits?workspaceId=missing')).response.status).toBe(404);
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('claims one overdue schedule, uses isolated conversation context, and continues at the next future wake', async () => {
    const p = await createWithAI();
    mode = 'waiting';
    api.store.run(
      'UPDATE pursuits SET next_run_at=? WHERE id=?',
      new Date(Date.now() - 5 * 60000).toISOString(),
      p.id,
    );
    api.pursuits.tick();
    api.pursuits.tick();
    const result = await settled(p.id);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ status: 'complete', trigger: 'schedule' });
    expect(result.pursuit.status).toBe('waiting');
    expect(Date.parse(result.pursuit.nextRunAt!)).toBeGreaterThan(Date.now());
    const conversation = api.store.get(
      'SELECT * FROM conversations WHERE id=?',
      result.runs[0].conversationId,
    );
    expect(conversation?.kind).toBe('pursuit_run');
    const messages = (
      await request<ChatMessage[]>(`/conversations/${result.runs[0].conversationId}/messages`)
    ).data;
    expect(messages[0].content).toContain('Run this pursuit');
    expect(messages[0].content).toContain(input.successCriteria);
    expect(messages[1].content).toContain('Reviewed the notes');
    expect(messages[1].status).toBe('complete');
    expect(
      calls.at(-1)?.messages.some((m) => String(m.content).includes('Create a scheduled pursuit')),
    ).toBe(false);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(2);
    const saved = await request<ChatMessage>(
      `/conversations/${result.runs[0].conversationId}/saved`,
      'PUT',
      { messageId: messages[1].id, saved: true },
    );
    expect(saved.data.saved).toBe(true);
  });
  it.each(['completed', 'blocked', 'waiting_for_you'] as const)(
    'honors a %s report and disables future wakes',
    async (status) => {
      const p = await createWithAI();
      mode = status;
      await request(`/pursuits/${p.id}/run`, 'POST');
      const result = await settled(p.id);
      expect(result.pursuit.status).toBe(status);
      expect(result.pursuit.nextRunAt).toBeNull();
      api.pursuits.tick();
      expect(api.pursuits.detail(p.id).runs).toHaveLength(1);
    },
  );
  it('keeps pause authoritative during a run and never starts a duplicate manual run', async () => {
    const p = await createWithAI();
    mode = 'slow';
    const run = (await request<PursuitRun>(`/pursuits/${p.id}/run`, 'POST')).data;
    expect((await request(`/pursuits/${p.id}/run`, 'POST')).response.status).toBe(409);
    await request(`/pursuits/${p.id}/status`, 'PUT', { status: 'paused' });
    const result = await settled(p.id);
    expect(result.pursuit.status).toBe('paused');
    expect(result.pursuit.nextRunAt).toBeNull();
    expect(result.runs[0].id).toBe(run.id);
    expect(result.runs[0].status).toBe('stopped');
    api.pursuits.tick();
    expect(api.pursuits.detail(p.id).runs).toHaveLength(1);
    await request(`/pursuits/${p.id}/status`, 'PUT', { status: 'active' });
    expect(api.pursuits.require(p.id).nextRunAt).not.toBeNull();
  });
  it('requires review when the bot omits a report instead of silently completing or looping', async () => {
    const p = await createWithAI();
    mode = 'no-report';
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(result.runs[0].error).toContain('without reporting');
    expect(result.pursuit.status).toBe('waiting_for_you');
    expect(result.pursuit.nextRunAt).toBeNull();
  });
  it('recovers an interrupted run without replaying writes, preserves run snapshots and enforces deadline expiry', async () => {
    const p = await createWithAI();
    const repository = new PursuitRepository(api.store);
    const run = repository.claim(p.id, 'manual', Date.now())!;
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir });
    const result = (await request<PursuitDetail>(`/pursuits/${p.id}`)).data;
    expect(result.runs[0]).toMatchObject({ id: run.id, status: 'interrupted' });
    expect(result.runs[0].snapshot.objective).toBe(input.objective);
    expect(result.pursuit.status).toBe('waiting_for_you');
    await request(`/pursuits/${p.id}/status`, 'PUT', { status: 'active' });
    api.store.run(
      'UPDATE pursuits SET deadline=? WHERE id=?',
      new Date(Date.now() - 1000).toISOString(),
      p.id,
    );
    api.pursuits.tick();
    expect(api.pursuits.require(p.id).status).toBe('blocked');
    expect(api.pursuits.detail(p.id).runs).toHaveLength(1);
  });
  it('keeps cadence without catch-up bursts across long downtime and timezone offsets', () => {
    const start = '2026-10-02T09:00:00-07:00',
      now = Date.parse('2026-10-02T19:01:00Z');
    expect(nextScheduledWake(start, 60, now)).toBe('2026-10-02T20:00:00.000Z');
  });
});
