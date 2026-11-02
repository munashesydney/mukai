import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { MockLanguageModelV4 } from 'ai/test';
import { wrapLanguageModel } from 'ai';
import { ProviderService } from './services/providerService';
import { seedTestBot } from './testFixtures';
import type { AIActivity } from '../shared/aiActivity';
import type { ChatEvent } from '../shared/ai';

let api: Awaited<ReturnType<typeof startApiServer>>,
  fixture: Server,
  dir: string,
  workspace: string;
let mode: 'http' | 'http-503' | 'stream' | 'always' | 'tool' | 'ok';
let requests: Record<string, unknown>[];
let clock: number;
const memory = {
  code: 'prefill_memory_exceeded',
  message: 'oMLX prefill memory guard rejected this prompt; reduce context length.',
  type: 'invalid_request_error',
};
async function request<T>(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return (await response.json()) as T;
}
async function waitFor(check: () => Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error('Timed out waiting for recovery state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function reply(res: ServerResponse, delta: unknown, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    `data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  );
}
function chat(text = 'Continue the task') {
  return fetch(api.url + '/bots/scout/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), text, attachmentIds: [] }),
  }).then((response) => response.text());
}
function lastMessage(text: string) {
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatEvent);
  const last = events.at(-1)!;
  if (last.type !== 'done' && last.type !== 'error')
    throw new Error('Missing saved final response');
  return last.message;
}
async function advanceQueue() {
  const activity = await request<AIActivity>('/ai-activity');
  const deadlines = activity.queued
    .map((work) => Date.parse(work.memoryPressure?.cooldownUntil || ''))
    .filter(Number.isFinite);
  clock = Math.max(clock + 1, ...deadlines.map((deadline) => deadline + 1));
  // Let the real watchdog observe queued time before admission after this simulated clock jump.
  await new Promise((resolve) => setTimeout(resolve, 260));
  await request('/limits', 'PUT', { aiConcurrency: 4 });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-memory-recovery-'));
  workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  mode = 'http';
  requests = [];
  clock = Date.now();
  api = await startApiServer(0, {
    dataDir: join(dir, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestBot(api.store);
  api.store.run('UPDATE workspaces SET memory_enabled=0');
  await request('/workspaces/default', 'PUT', { name: 'Recovery workspace', folder: workspace });
  fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (!input.stream)
      return res.end(
        JSON.stringify({
          id: 'summary',
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Summary unavailable' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    requests.push(input);
    const failure =
      mode === 'always' ||
      ((mode === 'http' || mode === 'http-503' || mode === 'stream') && requests.length === 1) ||
      (mode === 'tool' && requests.length === 2);
    if (failure) {
      if (mode === 'http' || mode === 'http-503') {
        res.writeHead(mode === 'http-503' ? 503 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: memory }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'stream')
        res.write(
          `data: ${JSON.stringify({ id: 'partial', choices: [{ index: 0, delta: { content: 'Saved progress. ' }, finish_reason: null }] })}\n\n`,
        );
      return res.end(`data: ${JSON.stringify({ error: memory })}\n\ndata: [DONE]\n\n`);
    }
    if (mode === 'tool' && requests.length === 1)
      return reply(
        res,
        {
          tool_calls: [
            {
              index: 0,
              id: 'write-once',
              type: 'function',
              function: {
                name: 'file_operations',
                arguments: JSON.stringify({
                  action: 'write_file',
                  path: 'once.txt',
                  content: 'Written once',
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    reply(res, { role: 'assistant', content: 'Task finished.' });
  });
  await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
  await request('/providers', 'POST', {
    name: 'oMLX fixture',
    kind: 'compatible',
    baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
    defaultModel: 'fixture',
    isDefault: true,
    supportsImages: false,
    apiKey: 'fixture',
    contextWindowTokens: 195000,
    maxOutputTokens: 8192,
  });
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  api.server.closeAllConnections();
  await new Promise<void>((done) => api.server.close(() => done()));
  api.dispose();
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

it.each(['http', 'http-503', 'stream', 'tool'] as const)(
  'recovers a %s memory rejection in the real chat loop without changing settings or replaying tools',
  async (kind) => {
    mode = kind;
    const pending = chat();
    await waitFor(async () =>
      Boolean((await request<AIActivity>('/ai-activity')).queued[0]?.memoryRetry),
    );
    expect(await request('/limits')).toMatchObject({ aiConcurrency: 4 });
    const queued = await request<AIActivity>('/ai-activity');
    expect(queued).toMatchObject({
      running: [],
      queued: [
        {
          memoryRetry: { attempt: 1, maxAttempts: 3 },
          memoryPressure: { configuredLimit: 4, effectiveLimit: 2 },
        },
      ],
    });
    await advanceQueue();
    const message = lastMessage(await pending);
    expect(message.status).toBe('complete');
    expect(message.content).toContain('Task finished.');
    expect(requests).toHaveLength(kind === 'tool' ? 3 : 2);
    if (kind === 'tool') {
      expect(readFileSync(join(workspace, 'once.txt'), 'utf8')).toBe('Written once');
      expect(message.activity?.filter((item) => item.tool === 'file_operations')).toHaveLength(1);
      expect(JSON.stringify(requests.at(-1))).toContain('write-once');
    }
  },
);

it('bounds recovery to three retries and one smaller-context attempt', async () => {
  mode = 'always';
  const pending = chat();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitFor(async () =>
      Boolean(
        (await request<AIActivity>('/ai-activity')).queued.some(
          (work) => work.memoryRetry?.attempt === attempt,
        ),
      ),
    );
    await advanceQueue();
  }
  await waitFor(async () =>
    Boolean(
      (await request<AIActivity>('/ai-activity')).queued.some(
        (work) => work.memoryRetry?.phase === 'compaction',
      ),
    ),
  );
  await advanceQueue();
  const message = lastMessage(await pending);
  expect(message.status).toBe('failed');
  expect(message.error).toContain('bounded automatic recovery');
  expect(requests).toHaveLength(5);
  expect(await request('/limits')).toMatchObject({ aiConcurrency: 4 });
});

it('cancels a cooling chat without starting another provider request', async () => {
  const pending = chat();
  await waitFor(async () =>
    Boolean((await request<AIActivity>('/ai-activity')).queued[0]?.memoryRetry),
  );
  await request('/bots/scout/stop', 'POST');
  expect(lastMessage(await pending).status).toBe('stopped');
  await advanceQueue();
  expect(requests).toHaveLength(1);
  expect((await request<AIActivity>('/ai-activity')).queued).toEqual([]);
});

it('does not automatically repeat a model step that already started tool execution', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'write-once',
            toolName: 'file_operations',
            input: JSON.stringify({
              action: 'write_file',
              path: 'once.txt',
              content: 'Written once',
            }),
          });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          void (async () => {
            const end = performance.now() + 1000;
            while (!existsSync(join(workspace, 'once.txt')) && performance.now() < end)
              await new Promise((resolve) => setTimeout(resolve, 5));
            controller.enqueue({ type: 'error', error: memory });
            controller.close();
          })();
        },
      }),
    }),
  });
  const resolve = ProviderService.prototype.resolve;
  vi.spyOn(ProviderService.prototype, 'resolve').mockImplementation(function (
    this: ProviderService,
    bot,
  ) {
    const config = resolve.call(this, bot);
    return {
      ...config,
      model: wrapLanguageModel({ model, middleware: this.ai.middleware(config.aiContext) }),
    };
  });
  const message = lastMessage(await chat());
  expect(readFileSync(join(workspace, 'once.txt'), 'utf8')).toBe('Written once');
  expect(message.status).toBe('failed');
  expect(message.error).toContain('available memory');
  expect(model.doStreamCalls).toHaveLength(1);
  expect(message.activity?.filter((item) => item.tool === 'file_operations')).toHaveLength(1);
});
