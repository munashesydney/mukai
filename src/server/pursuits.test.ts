import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './db/migrations';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { PursuitRepository } from './repositories/pursuitRepository';
import {
  type Pursuit,
  type PursuitDetail,
  type PursuitRun,
  type PursuitInput,
  type WorkpadEntry,
  type WorkpadPage,
} from '../shared/pursuits';
import type { Bot, ChatMessage, ToolInfo } from '../shared/ai';
import type { ApprovalState } from '../shared/approvals';
import { pursuitActionSchema, pursuitDefinition } from './tools/pursuits/definition';
import { z } from 'zod';
import { pursuitReportProblem, pursuitReportSchema } from './tools/pursuits/report';
import { executePursuit } from './tools/pursuits/execute';
import { WorkspaceRepository } from './repositories/workspaceRepository';
import { BotRepository } from './repositories/botRepository';
import { scoutBot } from './services/botService';

let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, dir: string;
let mode:
  | 'create'
  | 'waiting'
  | 'completed'
  | 'blocked'
  | 'waiting_for_you'
  | 'no-report'
  | 'slow'
  | 'reminder'
  | 'report-fail'
  | 'workpad'
  | 'workpad-fail'
  | 'invalid-report' = 'create';
let calls: { messages: { role: string; content: unknown }[] }[] = [];
let nextWake: string,
  reportAttempts = 0;
let reportOverride: Record<string, unknown> = {};
let workpadPursuitId = '';
const wakeReason = 'Allow time for the export to finish.';
const wakeInstructions =
  'Check the export status, then validate the output against the success criteria.';
const input: PursuitInput = {
  name: 'Review the notes',
  objective: 'Read notes and identify a useful next step.',
  successCriteria: 'A verified next step with supporting evidence.',
  firstRunAt: new Date(Date.now() + 3600000).toISOString(),
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
  nextWake = new Date(Date.now() + 2 * 3600000).toISOString();
  reportAttempts = 0;
  reportOverride = {};
  workpadPursuitId = '';
  dir = mkdtempSync(join(tmpdir(), 'mukai-pursuit-test-'));
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'memory-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ facts: [] }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    calls.push(body);
    if (
      ['report-fail', 'workpad-fail'].includes(mode) &&
      body.messages.some((m: { role: string }) => m.role === 'tool')
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Fixture failed after reporting.', type: 'invalid_request_error' },
        }),
      );
      return;
    }
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
    if (['workpad', 'workpad-fail'].includes(mode) && !hasTool) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-' + randomUUID(),
            type: 'function',
            function: {
              name: 'manage_pursuit',
              arguments: JSON.stringify({
                action: 'add_entry',
                pursuitId: workpadPursuitId,
                entry: {
                  type: 'work_item',
                  title: 'Verify exported rows',
                  content: 'The export is saved; validate the row count next.',
                  status: 'in_progress',
                },
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    const reminded = body.messages.some(
      (m: { role: string; content: unknown }) =>
        m.role === 'system' &&
        String(m.content).includes('This run finished without reporting a valid pursuit outcome'),
    );
    if (
      (!hasTool ||
        (mode === 'invalid-report' && reportAttempts === 1) ||
        (mode === 'workpad' && reportAttempts === 0)) &&
      mode !== 'no-report' &&
      mode !== 'slow' &&
      (mode !== 'reminder' || reminded)
    ) {
      const name = mode === 'create' ? 'manage_pursuit' : 'report_pursuit';
      const outcome =
        mode === 'reminder' ||
        mode === 'invalid-report' ||
        mode === 'report-fail' ||
        mode === 'workpad'
          ? 'waiting'
          : mode;
      const args =
        mode === 'create'
          ? { action: 'create', ...input }
          : {
              status: outcome,
              summary: 'Verified the notes. Recorded evidence and the next step.',
              ...(outcome === 'waiting'
                ? {
                    nextRunAt: nextWake,
                    nextRunReason: wakeReason,
                    nextRunInstructions: wakeInstructions,
                  }
                : {}),
              ...(mode === 'invalid-report' && reportAttempts === 0 ? reportOverride : {}),
            };
      if (name === 'report_pursuit') reportAttempts++;
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
  seedTestBot(api.store);
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
  it.each(['workpad', 'workpad-fail'] as const)(
    'persists model-authored entries with run provenance when the run is %s',
    async (runMode) => {
      const p = await createWithAI();
      workpadPursuitId = p.id;
      mode = runMode;
      await request(`/pursuits/${p.id}/run`, 'POST');
      const result = await settled(p.id);
      const workpad = api.pursuits.workpad(p.id);
      expect(workpad.entries).toHaveLength(1);
      expect(workpad.entries[0]).toMatchObject({
        title: 'Verify exported rows',
        status: 'in_progress',
        authorBotId: 'scout',
        originRunId: result.runs[0].id,
        updatedRunId: result.runs[0].id,
      });
      expect(result.runs[0].status).toBe(runMode === 'workpad' ? 'complete' : 'failed');
      expect(result.pursuit.status).toBe(runMode === 'workpad' ? 'waiting' : 'waiting_for_you');
    },
  );
  async function workpadTool(
    value: Parameters<typeof executePursuit>[0],
    conversationId?: string,
    bot?: Bot,
  ) {
    return executePursuit(
      value,
      {
        bot: bot || (await request<Bot[]>('/bots')).data.find((item) => item.id === 'scout')!,
        pursuits: api.pursuits,
        onActivity() {},
        signal: new AbortController().signal,
        scheduledRun: Boolean(conversationId),
        conversationId,
      },
      randomUUID(),
    );
  }
  it('validates Workpad actions without changing the object provider schema', () => {
    const pursuitId = randomUUID();
    expect(
      pursuitActionSchema.safeParse({
        action: 'add_entry',
        pursuitId,
        entry: { type: 'blocker', title: 'Access', content: 'Need access', status: 'done' },
      }).success,
    ).toBe(false);
    expect(
      pursuitActionSchema.safeParse({
        action: 'add_entry',
        pursuitId,
        entry: {
          type: 'note',
          title: 'Source',
          content: 'Reviewed',
          links: [{ kind: 'url', label: 'Bad URL', target: 'javascript:alert(1)' }],
        },
      }).success,
    ).toBe(false);
    expect(
      pursuitActionSchema.safeParse({
        action: 'update_entry',
        pursuitId,
        entryId: randomUUID(),
        expectedRevision: 1,
        patch: {},
      }).success,
    ).toBe(false);
    expect(
      pursuitActionSchema.safeParse({
        action: 'update_entry',
        pursuitId,
        entryId: randomUUID(),
        patch: { content: 'Updated' },
      }).success,
    ).toBe(false);
    expect(z.toJSONSchema(pursuitDefinition.inputSchema).type).toBe('object');
  });
  it('adds and updates entries through the tool, preserves provenance and rejects stale overwrites', async () => {
    const p = await createWithAI(),
      repository = new PursuitRepository(api.store);
    const run = repository.claim(p.id, 'manual', Date.now())!;
    const added = await workpadTool(
      {
        action: 'add_entry',
        pursuitId: p.id,
        entry: {
          type: 'work_item',
          title: 'Validate export',
          content: 'Check row counts against the source.',
          links: [{ kind: 'file', target: 'exports/results.csv', label: 'Export' }],
        },
      },
      run.conversationId,
    );
    expect(added.ok).toBe(true);
    const entry = added.result as WorkpadEntry;
    expect(entry).toMatchObject({
      status: 'todo',
      authorBotId: 'scout',
      originRunId: run.id,
      updatedRunId: run.id,
      revision: 1,
    });
    const updated = await workpadTool(
      {
        action: 'update_entry',
        pursuitId: p.id,
        entryId: entry.id,
        expectedRevision: 1,
        patch: { status: 'done', content: 'Verified all 42 source rows are present.' },
      },
      run.conversationId,
    );
    expect(updated.result).toMatchObject({
      id: entry.id,
      status: 'done',
      revision: 2,
      links: entry.links,
    });
    expect(
      (
        await workpadTool({
          action: 'update_entry',
          pursuitId: p.id,
          entryId: entry.id,
          expectedRevision: 1,
          patch: { content: 'Stale edit' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await workpadTool({
          action: 'update_entry',
          pursuitId: p.id,
          entryId: entry.id,
          expectedRevision: 2,
          patch: { status: 'resolved' },
        })
      ).ok,
    ).toBe(false);
    const read = await workpadTool({ action: 'get_entry', pursuitId: p.id, entryId: entry.id });
    expect(read.result).toMatchObject({
      content: 'Verified all 42 source rows are present.',
      revision: 2,
    });
    repository.finish(
      run.id,
      'failed',
      'Provider failed after saving progress.',
      'Provider failure',
      'waiting_for_you',
      Date.now(),
    );
    expect(api.pursuits.workpad(p.id).entries).toHaveLength(1);
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir });
    expect(api.pursuits.workpadEntry(p.id, entry.id)).toMatchObject({
      status: 'done',
      originRunId: run.id,
      revision: 2,
    });
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('filters, paginates, resolves and archives current state through tools and the read API', async () => {
    const p = await createWithAI(),
      bot = (await request<Bot[]>('/bots')).data.find((item) => item.id === 'scout')!;
    const blocker = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'blocker',
      title: 'Needs access',
      content: 'Provide export access.',
    });
    for (let i = 0; i < 22; i++)
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'note',
        title: `Finding ${i}`,
        content: `Verified finding ${i}.`,
      });
    const first = await workpadTool({ action: 'list_entries', pursuitId: p.id, limit: 10 });
    expect(first.result).toMatchObject({ total: 23, nextOffset: 10 });
    expect((first.result as WorkpadPage).entries[0].id).toBe(blocker.id);
    const second = await workpadTool({
      action: 'list_entries',
      pursuitId: p.id,
      limit: 10,
      offset: 10,
    });
    expect(
      (second.result as WorkpadPage).entries.some((entry) =>
        (first.result as WorkpadPage).entries.some((old) => old.id === entry.id),
      ),
    ).toBe(false);
    api.pursuits.updateEntryOwned(bot, p.id, blocker.id, { status: 'resolved' }, 1);
    const filtered = await request<WorkpadPage>(
      `/pursuits/${p.id}/workpad?type=blocker&status=resolved`,
    );
    expect(filtered.data.entries).toHaveLength(1);
    api.pursuits.updateEntryOwned(bot, p.id, blocker.id, { status: 'archived' }, 2);
    expect(api.pursuits.workpad(p.id).total).toBe(22);
    expect(api.pursuits.workpad(p.id, { includeArchived: true }).total).toBe(23);
    expect(
      (await request<WorkpadPage>(`/pursuits/${p.id}/workpad?status=archived`)).data.entries[0].id,
    ).toBe(blocker.id);
    expect(
      (await request<WorkpadEntry>(`/pursuits/${p.id}/workpad?entryId=${blocker.id}`)).data.status,
    ).toBe('archived');
    expect((await request(`/pursuits/${p.id}/workpad?limit=0`)).response.status).toBe(400);
  });
  it('enforces pursuit ownership, run scope and reference scope', async () => {
    const p = await createWithAI(),
      bot = (await request<Bot[]>('/bots')).data.find((item) => item.id === 'scout')!;
    const other = (
      await request<Bot>('/bots', 'POST', {
        name: 'Other',
        role: 'Assistant',
        instructions: 'Help.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'atlas',
      })
    ).data;
    const entry = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'decision',
      title: 'Use CSV',
      content: 'CSV matches the receiving system.',
    });
    expect(
      (
        await workpadTool(
          { action: 'get_entry', pursuitId: p.id, entryId: entry.id },
          undefined,
          other,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await workpadTool({ action: 'list_entries', pursuitId: p.id }, undefined, other)).ok,
    ).toBe(false);
    expect(
      (
        await workpadTool(
          {
            action: 'update_entry',
            pursuitId: p.id,
            entryId: entry.id,
            expectedRevision: 1,
            patch: { content: 'Unauthorized' },
          },
          undefined,
          other,
        )
      ).ok,
    ).toBe(false);
    const second = api.pursuits.create(bot, { ...input, name: 'Another pursuit' });
    const run = new PursuitRepository(api.store).claim(p.id, 'manual', Date.now())!;
    expect(() =>
      api.pursuits.addEntryOwned(
        bot,
        second.id,
        { type: 'note', title: 'Wrong run', content: 'Wrong pursuit.' },
        run.conversationId,
      ),
    ).toThrow('own Workpad');
    expect(() => api.pursuits.getEntryOwned(bot, second.id, entry.id)).toThrow('not found');
    expect(() =>
      api.pursuits.addEntryOwned(bot, second.id, {
        type: 'reference',
        title: 'Wrong entry',
        content: 'Linked entry',
        links: [{ kind: 'entry', target: entry.id, label: 'Decision' }],
      }),
    ).toThrow('not found');
    expect(() =>
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'reference',
        title: 'Missing conversation',
        content: 'Link',
        links: [{ kind: 'conversation', target: 'missing', label: 'Conversation' }],
      }),
    ).toThrow('workspace');
    expect(() =>
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'reference',
        title: 'Missing artifact',
        content: 'Link',
        links: [{ kind: 'artifact', target: 'missing', label: 'Artifact' }],
      }),
    ).toThrow('workspace');
    new WorkspaceRepository(api.store).create({
      id: 'other-workspace',
      name: 'Other workspace',
      folder: null,
      createdAt: new Date().toISOString(),
    });
    const foreignBot = scoutBot('other-workspace', 'foreign-bot');
    new BotRepository(api.store).create(foreignBot);
    expect(() =>
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'reference',
        title: 'Foreign conversation',
        content: 'Link',
        links: [{ kind: 'conversation', target: 'bot-foreign-bot', label: 'Foreign conversation' }],
      }),
    ).toThrow('workspace');
    const linked = api.pursuits.addEntryOwned(
      bot,
      p.id,
      {
        type: 'reference',
        title: 'Supporting context',
        content: 'Why CSV was selected.',
        links: [
          { kind: 'entry', target: entry.id, label: 'Decision' },
          { kind: 'conversation', target: run.conversationId, label: 'Run' },
        ],
      },
      run.conversationId,
    );
    expect(linked.links).toHaveLength(2);
    new PursuitRepository(api.store).finish(
      run.id,
      'complete',
      'Recorded context.',
      null,
      'completed',
      Date.now(),
    );
  });
  it('retrieves provenance runs older than the recent run list and scopes them to their pursuit', async () => {
    const p = await createWithAI(),
      bot = (await request<Bot[]>('/bots')).data.find((item) => item.id === 'scout')!,
      repository = new PursuitRepository(api.store);
    const report = pursuitReportSchema.parse({
      status: 'waiting',
      summary: 'Work saved.',
      nextRunAt: nextWake,
      nextRunReason: wakeReason,
      nextRunInstructions: wakeInstructions,
    });
    const first = repository.claim(p.id, 'manual', Date.now())!;
    const entry = api.pursuits.addEntryOwned(
      bot,
      p.id,
      { type: 'decision', title: 'Initial decision', content: 'Preserve this context.' },
      first.conversationId,
    );
    repository.finish(first.id, 'complete', report.summary, null, 'waiting', Date.now(), report);
    for (let i = 0; i < 100; i++) {
      const run = repository.claim(p.id, 'manual', Date.now())!;
      repository.finish(run.id, 'complete', report.summary, null, 'waiting', Date.now(), report);
    }
    expect(repository.runs(p.id)).toHaveLength(100);
    expect(repository.runs(p.id).some((run) => run.id === first.id)).toBe(false);
    expect(
      (await request<PursuitRun>(`/pursuits/${p.id}/run?runId=${entry.originRunId}`)).data.id,
    ).toBe(first.id);
    const other = api.pursuits.create(bot, { ...input, name: 'Other pursuit' });
    expect((await request(`/pursuits/${other.id}/run?runId=${first.id}`)).response.status).toBe(
      404,
    );
  });
  it('bounds the automatic digest, prioritizes blockers, and includes it in fresh run context', async () => {
    const p = await createWithAI(),
      bot = (await request<Bot[]>('/bots')).data.find((item) => item.id === 'scout')!,
      repository = new PursuitRepository(api.store);
    for (let i = 0; i < 35; i++)
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'note',
        title: `Finding ${i}`,
        content: 'Evidence. '.repeat(600),
      });
    for (let i = 0; i < 24; i++)
      api.pursuits.addEntryOwned(bot, p.id, {
        type: 'blocker',
        title: `Obstacle ${i}`,
        content: 'Resolve before final delivery.',
      });
    const decision = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'decision',
      title: 'Use CSV',
      content: 'CSV matches the receiving system.',
      links: [
        { kind: 'url', target: 'https://example.com/' + 'a'.repeat(600), label: 'Long source' },
        { kind: 'url', target: 'https://example.com/evidence', label: 'Evidence' },
      ],
    });
    const completed = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'work_item',
      title: 'Export rows',
      content: 'All source rows exported.',
      status: 'done',
    });
    const blocker = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'blocker',
      title: 'Export approval',
      content: 'Need approval to publish the completed export.',
    });
    const archived = api.pursuits.addEntryOwned(bot, p.id, {
      type: 'note',
      title: 'Stale finding',
      content: 'Superseded.',
      status: 'archived',
    });
    const digest = repository.workpad.digest(p.id);
    expect(JSON.stringify(digest).length).toBeLessThan(11000);
    expect(digest.entries.length).toBeLessThanOrEqual(16);
    expect(digest.entries[0]).toMatchObject({ id: blocker.id });
    expect(digest.entries.some((entry) => 'id' in entry && entry.id === decision.id)).toBe(true);
    expect(digest.entries.some((entry) => 'id' in entry && entry.id === completed.id)).toBe(true);
    expect(digest.entries.find((entry) => 'id' in entry && entry.id === decision.id)).toMatchObject(
      {
        linksTruncated: true,
        links: [{ kind: 'url', target: 'https://example.com/evidence', label: 'Evidence' }],
      },
    );
    expect(digest.entries.some((entry) => 'id' in entry && entry.id === archived.id)).toBe(false);
    expect(digest.omittedCount).toBeGreaterThan(0);
    mode = 'waiting';
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(result.pursuit.status).toBe('waiting');
    expect(
      calls
        .at(-1)!
        .messages.some(
          (message) => message.role === 'user' && String(message.content).includes(blocker.id),
        ),
    ).toBe(true);
    expect(
      calls
        .at(-1)!
        .messages.some(
          (message) =>
            message.role === 'system' &&
            String(message.content).includes('Entry creation is optional'),
        ),
    ).toBe(true);
  });
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
    };
    expect(pursuitActionSchema.parse({ action: 'create', ...required })).toMatchObject({
      firstRunAt: null,
      deadline: null,
    });
  });
  it('creates only through an AI tool, binds ownership, and blocks another bot from managing it', async () => {
    const p = await createWithAI();
    expect(String(calls[0].messages[0].content)).toMatch(/^No current pursuits\n/);
    const updatedSystem = String(calls.at(-1)!.messages[0].content);
    expect(updatedSystem).toMatch(/^Current pursuits /);
    expect(JSON.parse(updatedSystem.split('\n')[1])).toEqual([p.name]);
    expect(p).toMatchObject({
      ownerBotId: 'scout',
      status: 'active',
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
        role: 'Assistant',
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
    expect(result.pursuit).toMatchObject({
      nextRunAt: nextWake,
      nextRunReason: wakeReason,
      nextRunInstructions: wakeInstructions,
    });
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
    expect(result.runs[0].status).toBe('failed');
    const runCalls = calls.filter((call) =>
      call.messages.some((m) => String(m.content).includes('Run this pursuit')),
    );
    expect(runCalls).toHaveLength(3);
    expect(runCalls.at(-1)?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
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
  it('repairs a missing report in the same run without creating a user message', async () => {
    const p = await createWithAI();
    mode = 'reminder';
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe('complete');
    expect(result.pursuit.nextRunAt).toBe(nextWake);
    expect(
      api.store
        .all(
          'SELECT role FROM messages WHERE conversation_id=? ORDER BY sequence',
          result.runs[0].conversationId,
        )
        .map((m) => m.role),
    ).toEqual(['user', 'assistant']);
    expect(reportAttempts).toBe(1);
  });
  it.each([
    { nextRunAt: null },
    { nextRunReason: null },
    { nextRunInstructions: null },
    { nextRunAt: '2020-01-01T00:00:00Z' },
    { nextRunInstructions: '   ' },
  ])('rejects an invalid continuation and lets the AI correct it: %j', async (invalid) => {
    const p = await createWithAI();
    mode = 'invalid-report';
    reportOverride = invalid;
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(reportAttempts).toBe(2);
    expect(result.runs[0].status).toBe('complete');
    expect(result.pursuit).toMatchObject({
      nextRunAt: nextWake,
      nextRunReason: wakeReason,
      nextRunInstructions: wakeInstructions,
    });
  });
  it('passes continuation instructions and recommends optional workspace memory on the next run', async () => {
    const p = await createWithAI();
    mode = 'waiting';
    await request(`/pursuits/${p.id}/run`, 'POST');
    await settled(p.id);
    mode = 'completed';
    api.store.run(
      'UPDATE pursuits SET next_run_at=? WHERE id=?',
      new Date(Date.now() - 1000).toISOString(),
      p.id,
    );
    api.pursuits.tick();
    const result = await settled(p.id);
    expect(result.runs).toHaveLength(2);
    const latest = calls.at(-1)!.messages;
    expect(
      latest.some(
        (m) =>
          m.role === 'user' &&
          String(m.content).includes(wakeInstructions) &&
          String(m.content).includes(wakeReason),
      ),
    ).toBe(true);
    expect(
      latest.some(
        (m) =>
          m.role === 'system' &&
          String(m.content).includes('scope workspace') &&
          String(m.content).includes('this is optional'),
      ),
    ).toBe(true);
  });
  it('normalizes the AI wake timestamp with a timezone offset', async () => {
    const p = await createWithAI();
    mode = 'waiting';
    nextWake = new Date(Date.now() + 3600000).toISOString().replace('Z', '+00:00');
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(result.pursuit.nextRunAt).toBe(new Date(nextWake).toISOString());
  });
  it('requires wakes before the deadline and explicit null scheduling on terminal outcomes', () => {
    const now = Date.now();
    const report = pursuitReportSchema.parse({
      status: 'waiting',
      summary: 'Work saved.',
      nextRunAt: nextWake,
      nextRunReason: wakeReason,
      nextRunInstructions: wakeInstructions,
    });
    expect(pursuitReportProblem(report, now, new Date(now + 60000).toISOString())).toContain(
      'before the pursuit deadline',
    );
    expect(pursuitReportProblem({ ...report, status: 'completed' }, now, null)).toContain(
      'Set nextRunAt',
    );
    expect(
      pursuitReportProblem(
        pursuitReportSchema.parse({ status: 'completed', summary: 'Verified.' }),
        now,
        null,
      ),
    ).toBeUndefined();
  });
  it('schedules an immediate first run without an interval or firstRunAt', () => {
    const repository = new PursuitRepository(api.store);
    const now = Date.now();
    const pursuit = repository.create('default', 'scout', { ...input, firstRunAt: null }, now);
    expect(pursuit.nextRunAt).toBe(new Date(now).toISOString());
    expect(pursuit.nextRunInstructions).toBe(input.objective);
    expect(pursuit).not.toHaveProperty('intervalMinutes');
    const run = repository.claim(pursuit.id, 'schedule', now)!;
    expect(repository.find(pursuit.id)!.nextRunAt).toBeNull();
    repository.finish(run.id, 'complete', 'Verified.', null, 'completed', now);
  });
  it('preserves existing schedules and legacy interval data during the upgrade', () => {
    const legacy = new DatabaseSync(':memory:');
    try {
      legacy.exec(`CREATE TABLE pursuits(id TEXT PRIMARY KEY, objective TEXT NOT NULL, interval_minutes INTEGER NOT NULL, next_run_at TEXT, next_run_reason TEXT NOT NULL);
        INSERT INTO pursuits VALUES('legacy','Validate the export',90,'2026-11-01T09:00:00.000Z','Scheduled wake-up');`);
      legacy.exec(
        migrations.find((sql) =>
          sql.includes('ALTER TABLE pursuits ADD COLUMN next_run_instructions'),
        )!,
      );
      expect(legacy.prepare('SELECT * FROM pursuits').get()).toMatchObject({
        id: 'legacy',
        interval_minutes: 90,
        next_run_at: '2026-11-01T09:00:00.000Z',
        next_run_reason: 'Scheduled wake-up',
        next_run_instructions: 'Validate the export',
      });
    } finally {
      legacy.close();
    }
  });
  it('does not schedule a reported continuation if the response subsequently fails', async () => {
    const p = await createWithAI();
    mode = 'report-fail';
    await request(`/pursuits/${p.id}/run`, 'POST');
    const result = await settled(p.id);
    expect(reportAttempts).toBe(1);
    expect(result.runs[0].status).toBe('failed');
    expect(result.pursuit.status).toBe('waiting_for_you');
    expect(result.pursuit.nextRunAt).toBeNull();
  });
  it('restores the exact pursuit run and pending approval after app shutdown', async () => {
    const pursuit = await createWithAI();
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'completed';
    const run = api.pursuits.runNow(pursuit.id);
    const pending = await vi.waitFor(async () => {
      const value = (await request<ApprovalState>('/approvals')).data.pending;
      expect(value).toHaveLength(1);
      return value[0];
    });
    expect(pending.conversationId).toBe(run.conversationId);
    expect(pending.toolName).toBe('report_pursuit');
    await api.shutdown();
    expect(api.pursuits.detail(pursuit.id).runs[0].status).toBe('running');
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir });
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([pending]);
    expect(
      (await request<ChatMessage[]>(`/conversations/${run.conversationId}/messages`)).data[1]
        .status,
    ).toBe('streaming');
    await vi.waitFor(async () =>
      expect(
        (await request(`/approvals/${pending.id}`, 'POST', { approved: true })).response.status,
      ).toBe(200),
    );
    const detail = await settled(pursuit.id);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      id: run.id,
      conversationId: run.conversationId,
      status: 'complete',
      error: null,
    });
    expect(detail.pursuit.status).toBe('completed');
  });

  it('preserves the AI-selected continuation across a restart', async () => {
    const p = await createWithAI();
    mode = 'waiting';
    await request(`/pursuits/${p.id}/run`, 'POST');
    await settled(p.id);
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir });
    expect(api.pursuits.require(p.id)).toMatchObject({
      status: 'waiting',
      nextRunAt: nextWake,
      nextRunReason: wakeReason,
      nextRunInstructions: wakeInstructions,
    });
    api.pursuits.tick();
    expect(api.pursuits.detail(p.id).runs).toHaveLength(1);
  });
  it('shows only this bot’s unfinished pursuits in normal chats, including paused and blocked work', async () => {
    const scout = (await request<Bot[]>('/bots')).data.find((bot) => bot.id === 'scout')!;
    const mine = api.pursuits.create(scout, { ...input, name: 'My paused pursuit' });
    api.pursuits.control(mine.id, 'paused');
    const blocked = api.pursuits.create(scout, { ...input, name: 'My blocked pursuit' });
    new PursuitRepository(api.store).setStatus(blocked.id, 'blocked', 'Needs access', Date.now());
    const done = api.pursuits.create(scout, { ...input, name: 'My completed pursuit' });
    api.pursuits.control(done.id, 'completed');
    const other = (
      await request<Bot>('/bots', 'POST', {
        name: 'Other',
        role: 'Assistant',
        instructions: 'Help.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'atlas',
      })
    ).data;
    api.pursuits.create(other, { ...input, name: 'Other bot pursuit' });
    mode = 'no-report';
    const chat = async () => {
      const response = await fetch(api.url + '/bots/scout/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: randomUUID(),
          text: 'What am I pursuing?',
          attachmentIds: [],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      return String(calls.at(-1)!.messages[0].content);
    };
    const system = await chat();
    const current = JSON.parse(system.split('\n')[1]);
    expect(current).toHaveLength(2);
    expect(current).toEqual(expect.arrayContaining([mine.name, blocked.name]));
    api.pursuits.control(mine.id, 'completed');
    api.pursuits.control(blocked.id, 'completed');
    expect(await chat()).toMatch(/^No current pursuits\n/);
  });
});
