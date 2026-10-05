import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { migrations } from './db/migrations';
import type {
  Bot,
  ChatEvent,
  ChatMessage,
  ProviderSettings,
  Attachment,
  Workspace,
  FileArtifact,
  ToolInfo,
} from '../shared/ai';
import type { FileChangeDetail } from '../shared/fileChanges';
import type { Conversation } from '../shared/conversations';
import { IMAGE_OMITTED, RESULT_TRUNCATED } from './services/toolResultPolicy';
import type { ApprovalState } from '../shared/approvals';

function inputBot() {
  return {
    name: 'Mukai',
    role: 'Assistant',
    instructions: 'Help the user.',
    providerId: null,
    model: null,
    supportsImages: null,
    avatar: 'nova' as const,
  };
}

// A test-only OpenAI protocol server exercises the actual SDK, HTTP streaming,
// persistence, and error handling without a cloud key or billable requests.
let fixture: Server, api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
let calls: {
  model: string;
  messages: { role: string; content: unknown }[];
  max_tokens?: number;
  stream?: boolean;
  thinking?: { type: string };
}[];
let mode:
  | 'normal'
  | 'fail'
  | 'upstream-fail'
  | 'slow'
  | 'tools'
  | 'invalid-tool'
  | 'tool-limit'
  | 'no-final'
  | 'truncated'
  | 'truncated-once'
  | 'usage'
  | 'compaction-fail'
  | 'compaction-length'
  | 'compaction-empty'
  | 'compaction-filter'
  | 'compaction-slow'
  | 'overflow'
  | 'checkpoint'
  | 'raw-tool-once'
  | 'raw-tool-always'
  | 'long-browser'
  | 'oversized-results'
  | 'runtime-tools'
  | 'image-view'
  | 'approval-custom'
  | 'approval-parallel'
  | 'ask-clarification'
  | 'ask-approval'
  | 'ask-mixed'
  | 'approval-memory' = 'normal';
let endpoint = '';
let project = '';
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
async function configure(vision = false) {
  const result = await request<ProviderSettings>('/providers', 'POST', {
    name: 'Local test',
    kind: 'compatible',
    baseUrl: endpoint,
    defaultModel: 'test-chat',
    supportsImages: vision,
    isDefault: true,
    apiKey: 'private-test-key',
  });
  expect(result.response.status).toBe(201);
  return result.data;
}
async function chat(
  text: string,
  requestId = randomUUID(),
  botId = 'scout',
  attachmentIds: string[] = [],
) {
  const response = await fetch(`${api.url}/bots/${botId}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, text, attachmentIds }),
  });
  expect(response.status).toBe(200);
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatEvent);
  return { events, requestId };
}
async function upload(name: string, bytes: Buffer, botId = 'scout') {
  const response = await fetch(`${api.url}/bots/${botId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'X-Filename': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  });
  return { response, data: (await response.json()) as Attachment };
}
async function privateChat(
  conversationId: string,
  text: string,
  requestId = randomUUID(),
  attachmentIds: string[] = [],
) {
  const response = await fetch(`${api.url}/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, text, attachmentIds }),
  });
  expect(response.status).toBe(200);
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatEvent);
}
async function spaceChat(
  id: string,
  text: string,
  botId: string | null = null,
  requestId = randomUUID(),
) {
  const response = await fetch(`${api.url}/conversations/${id}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, botId, requestId }),
  });
  expect(response.status).toBe(200);
  return {
    events: (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatEvent),
    requestId,
  };
}
function pdfFixture() {
  const text = 'BT /F1 12 Tf 20 150 Td (Readable PDF note) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
function docxFixture() {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Readable DOCX note</w:t></w:r></w:p></w:body></w:document>',
  );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'mukai-test-'));
  calls = [];
  mode = 'normal';
  project = '';
  let overflowed = false;
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (mode === 'upstream-fail') {
      res
        .writeHead(503, {
          'Content-Type': 'application/json',
          'x-request-id': 'fixture-request-42',
          'retry-after-ms': '0',
        })
        .end(
          JSON.stringify({
            error: {
              type: 'server_error',
              code: 'upstream_reset',
              message: 'Upstream reset private-test-key',
            },
          }),
        );
      return;
    }
    if (
      mode === 'fail' ||
      (mode === 'checkpoint' &&
        body.messages.some((message: { role: string }) => message.role === 'tool'))
    ) {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'DO NOT EXPOSE private-test-key' } }));
      return;
    }
    if (mode === 'overflow' && body.stream && !overflowed) {
      overflowed = true;
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'context_length_exceeded private-test-key' } }));
      return;
    }
    if (!body.stream) {
      if (mode === 'compaction-slow') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20000);
          res.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (res.destroyed) return;
      }
      const firstSummary = calls.filter((call) => !call.stream).length === 1;
      const truncated = mode === 'compaction-length' && firstSummary;
      const empty = mode === 'compaction-fail' || (mode === 'compaction-empty' && firstSummary);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  empty || truncated
                    ? ''
                    : JSON.stringify(body.messages).includes('Summarize working memory')
                      ? 'Earlier conversation notes: retain verified findings and completed actions. Continue the exact current request without repeating successful operations.' +
                        (mode === 'oversized-results'
                          ? ['Useful page findings', RESULT_TRUNCATED, IMAGE_OMITTED]
                              .filter((finding) => JSON.stringify(body.messages).includes(finding))
                              .join(' ')
                          : '')
                      : 'OK',
              },
              finish_reason: truncated
                ? 'length'
                : mode === 'compaction-filter'
                  ? 'content_filter'
                  : 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (mode === 'image-view') {
      const completed = JSON.stringify(body.messages).includes('"tool_call_id":"image-view"');
      const delta = completed
        ? { content: 'Image invocation resolved.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'image-view',
                type: 'function',
                function: {
                  name: 'image',
                  arguments: JSON.stringify({ action: 'view', path: join(dir, 'outside.png') }),
                },
              },
            ],
          };
      res.write(
        `data: ${JSON.stringify({ id: 'image', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: completed ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (
      mode === 'approval-custom' ||
      mode === 'approval-memory' ||
      mode === 'approval-parallel' ||
      mode === 'ask-clarification' ||
      mode === 'ask-approval' ||
      mode === 'ask-mixed'
    ) {
      const clarification = {
        action: 'clarification',
        question: 'Which audience should I focus on?',
        options: [
          { label: 'New customers', description: 'Reach a wider audience.', recommended: true },
          { label: 'Existing customers', recommended: false },
        ],
      };
      const completed = body.messages.some((message: { role: string }) => message.role === 'tool');
      res.write(
        `data: ${JSON.stringify({
          id: 'approval-custom',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: completed
                ? { content: 'Custom call resolved.' }
                : {
                    tool_calls: Array.from(
                      { length: mode === 'approval-parallel' || mode === 'ask-mixed' ? 3 : 1 },
                      (_, index) => ({
                        index,
                        id: `custom-call-${index + 1}`,
                        type: 'function',
                        function: {
                          name:
                            mode === 'ask-mixed' && index === 2
                              ? 'browser'
                              : mode.startsWith('ask-')
                                ? 'ask'
                                : mode === 'approval-memory'
                                  ? 'memory'
                                  : 'approval_echo',
                          arguments:
                            mode === 'ask-mixed' && index === 2
                              ? '{"action":"tabs"}'
                              : mode === 'ask-approval' || (mode === 'ask-mixed' && index === 1)
                                ? JSON.stringify({
                                    action: 'approval',
                                    question: 'May I publish this draft?',
                                  })
                                : mode.startsWith('ask-')
                                  ? JSON.stringify(clarification)
                                  : mode === 'approval-memory'
                                    ? '{"action":"search","query":"user preferences"}'
                                    : '{"value":"approved"}',
                        },
                      }),
                    ),
                  },
              finish_reason: completed ? 'stop' : 'tool_calls',
            },
          ],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'oversized-results') {
      // Count generations independently of retained history: compaction may replace
      // old calls/results while this fixture must continue, rather than replay them.
      const step = calls.filter((call) => call.stream).length - 1;
      const actions =
        step === 0
          ? [{ action: 'open', url: 'https://example.com' }]
          : step === 1
            ? [
                { action: 'snapshot', sessionId: api.browsers.list('default')[0].id },
                { action: 'snapshot', sessionId: api.browsers.list('default')[0].id },
              ]
            : step === 2
              ? [{ action: 'screenshot', sessionId: api.browsers.list('default')[0].id }]
              : [];
      const delta = actions.length
        ? {
            tool_calls: actions.map((input, index) => ({
              index,
              id: `bounded-${step}-${index}`,
              type: 'function',
              function: { name: 'browser', arguments: JSON.stringify(input) },
            })),
          }
        : { content: 'Large-result browser checks finished.' };
      res.write(
        `data: ${JSON.stringify({ id: 'bounded', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: actions.length ? 'tool_calls' : 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (['raw-tool-once', 'raw-tool-always', 'long-browser'].includes(mode)) {
      const completed = body.messages.filter(
        (message: { role: string }) => message.role === 'tool',
      ).length;
      const recovering = JSON.stringify(body.messages).includes('Runtime notice:');
      const send = (delta: unknown, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'recovery', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (
        mode === 'raw-tool-always' ||
        (mode === 'raw-tool-once' && completed === 1 && !recovering)
      )
        send(
          {
            content:
              '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="browser">not executed</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
          },
          'stop',
        );
      else if (body.tools?.length && completed < (mode === 'long-browser' ? 12 : 2))
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: 'browser-' + completed,
                type: 'function',
                function: {
                  name: 'browser',
                  arguments: JSON.stringify(
                    mode === 'long-browser'
                      ? completed === 0
                        ? { action: 'open', url: 'https://example.com' }
                        : { action: 'snapshot', sessionId: api.browsers.list('default')[0].id }
                      : { action: 'tabs' },
                  ),
                },
              },
            ],
          },
          'tool_calls',
        );
      else send({ content: 'All browser checks finished.' }, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'runtime-tools') {
      const completed = body.messages.filter(
        (message: { role: string }) => message.role === 'tool',
      ).length;
      const steps = [
        {
          name: 'terminal',
          input: {
            command:
              process.platform === 'win32'
                ? 'Write-Output "terminal fixture"'
                : 'printf "terminal fixture"',
            yieldMs: 30000,
          },
        },
        { name: 'process', input: { action: 'list' } },
        { name: 'browser', input: { action: 'tabs' } },
      ];
      const send = (delta: unknown, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'runtime', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (completed < steps.length) {
        const step = steps[completed];
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: 'runtime-' + completed,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(step.input) },
              },
            ],
          },
          'tool_calls',
        );
      } else
        send(
          { content: 'Verified terminal output, process status, and browser sessions.' },
          'stop',
        );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (['tools', 'invalid-tool', 'tool-limit', 'no-final', 'checkpoint'].includes(mode)) {
      const completed = body.messages.filter(
        (message: { role: string }) => message.role === 'tool',
      ).length;
      const actions = [
        { action: 'list', path: '.' },
        { action: 'read_file', path: 'notes.txt' },
        { action: 'write_file', path: 'draft.md', content: '# A useful draft\nFirst version.' },
        {
          action: 'patch',
          path: 'draft.md',
          oldText: 'First version.',
          newText: 'A clearer second version.',
        },
        { action: 'search_files', query: 'clearer' },
      ];
      if (mode === 'invalid-tool') actions[0] = { action: 'invalid_action', path: '.' };
      if (mode === 'checkpoint')
        actions[0] = { action: 'write_file', path: 'checkpoint.txt', content: 'Saved once.' };
      const send = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'tools', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (mode === 'tool-limit' || mode === 'no-final') {
        if (!body.tools?.length) {
          send(
            mode === 'no-final'
              ? {}
              : {
                  content:
                    'Final report: the operation limit was reached. Some tool calls failed, and verification remains unfinished.',
                },
            'stop',
          );
        } else {
          send({ reasoning_content: 'Check the workspace and handle any errors.' });
          send({ content: `Progress for step ${completed + 1}.` });
          send({
            tool_calls: [
              {
                index: 0,
                id: `limit-${completed}`,
                type: 'function',
                function: {
                  name: 'file_operations',
                  arguments: JSON.stringify(
                    completed === 1000 - 1
                      ? { action: 'invalid_action' }
                      : { action: 'list', path: '.' },
                  ),
                },
              },
            ],
          });
          send({}, 'tool_calls');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      if (completed < actions.length) {
        if (!completed)
          send({
            reasoning_content: 'I will review the notes, create a draft, and check the result.',
          });
        send({ content: `Progress before operation ${completed + 1}.` });
        send({
          tool_calls: [
            {
              index: 0,
              id: `file-call-${completed}`,
              type: 'function',
              function: { name: 'file_operations', arguments: JSON.stringify(actions[completed]) },
            },
          ],
        });
        send({}, 'tool_calls');
      } else
        send({ content: 'I created draft.md and refined it using the workspace notes.' }, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }
    const chunk = (text: string, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`,
      );
    if (mode === 'truncated-once') {
      res.write(
        `data: ${JSON.stringify({ id: 'continuation', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'Continue from the saved answer.' }, finish_reason: null }] })}\n\n`,
      );
      chunk(
        calls.length === 1 ? 'First half ' : 'and the rest.',
        calls.length === 1 ? 'length' : 'stop',
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    chunk('A real SDK ');
    if (mode === 'slow') {
      const timer = setTimeout(() => {
        if (!res.destroyed) {
          chunk('response.', 'stop');
          res.end('data: [DONE]\n\n');
        }
      }, 1000);
      res.on('close', () => clearTimeout(timer));
    } else {
      chunk('response.', mode === 'truncated' ? 'length' : 'stop');
      if (mode === 'usage')
        res.write(
          `data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
  let snapshotCount = 0;
  api = await startApiServer(0, {
    dataDir: dir,
    memoryExtractor: async () => ({ facts: [] }),
    embeddedBrowser: {
      open: async (info) => ({
        isClosed: () => false,
        close: async () => {},
        send: async (method) => {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
          if (method === 'Runtime.evaluate')
            return {
              result: {
                value: {
                  url: info.url,
                  title: 'Fixture',
                  text: 'Progress ' + ++snapshotCount,
                  controls: [],
                },
              },
            };
          return {};
        },
      }),
      bounds: () => {},
      shutdown: async () => {},
    },
  });
  seedTestBot(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await close(api.server);
  await close(fixture);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(dir.startsWith(join(tmpdir(), 'mukai-test-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
  if (project) {
    expect(project.startsWith(join(tmpdir(), 'mukai-project-'))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
describe('Mukai bots and AI API', () => {
  it.each([
    { approvalMode: 'full-access', approved: true, restart: false },
    { approvalMode: 'ask-for-approval', approved: true, restart: true },
    { approvalMode: 'ask-for-approval', approved: false, restart: false },
  ])(
    'views an external image through the SDK in $approvalMode with approved=$approved',
    async ({ approvalMode, approved, restart }) => {
      await configure(true);
      await request('/approvals', 'PUT', { mode: approvalMode });
      const path = join(dir, 'outside.png');
      const png = await sharp({
        create: { width: 30, height: 20, channels: 3, background: '#0088cc' },
      })
        .png()
        .toBuffer();
      if (approvalMode === 'full-access') writeFileSync(path, png);
      mode = 'image-view';
      const running = chat('Inspect a local image outside the workspace');
      if (approvalMode === 'ask-for-approval') {
        const item = await pendingApproval('image-view');
        expect(item).toMatchObject({ toolName: 'image', input: { action: 'view', path } });
        // The file does not exist while the gate is waiting: no read has occurred.
        expect(
          (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity || [],
        ).toEqual([]);
        if (restart) {
          await api.shutdown();
          await running;
          await close(api.server);
          api = await startApiServer(0, {
            dataDir: dir,
            memoryExtractor: async () => ({ facts: [] }),
          });
          expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([item]);
        }
        if (approved) writeFileSync(path, png);
        await vi.waitFor(async () =>
          expect(
            (await request(`/approvals/${item.id}`, 'POST', { approved })).response.status,
          ).toBe(200),
        );
      }
      await running;
      await vi.waitFor(async () =>
        expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
          'complete',
        ),
      );
      expect(
        JSON.stringify(calls.at(-1)!.messages),
        JSON.stringify(calls.at(-1)!.messages),
      ).toEqual(
        approved
          ? expect.stringContaining('data:image/png;base64')
          : expect.not.stringContaining('data:image/png;base64'),
      );
      const activities = (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity;
      expect(JSON.stringify(activities)).not.toContain('iVBOR');
      expect(activities).toMatchObject([
        {
          tool: 'image',
          action: approved ? 'view' : 'rejected',
          status: approved ? 'complete' : 'failed',
        },
      ]);
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    },
  );

  it('lists image tools without a workspace folder and honors bot assignment', async () => {
    const tools = (await request<ToolInfo[]>('/tools?workspaceId=default')).data;
    expect(tools).toContainEqual(
      expect.objectContaining({ id: 'image', available: true, actions: ['read', 'view'] }),
    );
    await request('/tools/assignments?workspaceId=default', 'PUT', {
      botId: 'scout',
      toolId: 'image',
      enabled: false,
    });
    expect((await request('/tools/assignments?workspaceId=default')).data).toContainEqual({
      botId: 'scout',
      toolId: 'image',
      enabled: false,
    });
  });

  it.each([
    { approvalMode: 'ask-for-approval', answer: 'New customers', restart: false },
    { approvalMode: 'full-access', answer: 'Focus on partners instead.', restart: true },
  ])(
    'returns the actual clarification answer in $approvalMode, preserving pending questions on restart',
    async ({ approvalMode, answer, restart }) => {
      await configure();
      await request('/approvals', 'PUT', { mode: approvalMode });
      mode = 'ask-clarification';
      const result = chat('Ask who to focus on');
      const item = await pendingApproval('custom-call-1');
      expect(item).toMatchObject({
        toolName: 'ask',
        ask: {
          action: 'clarification',
          options: [
            { label: 'New customers', recommended: true },
            { label: 'Existing customers', recommended: false },
          ],
        },
      });
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1);
      expect(
        (await request(`/approvals/${item.id}`, 'POST', { approved: true })).response.status,
      ).toBe(400);
      expect(
        (await request(`/approvals/${item.id}`, 'POST', { answer: '  ' })).response.status,
      ).toBe(400);
      if (restart) {
        await api.shutdown();
        await result;
        await close(api.server);
        api = await startApiServer(0, {
          dataDir: dir,
          memoryExtractor: async () => ({ facts: [] }),
        });
        expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([item]);
        expect(calls.filter((call) => call.stream)).toHaveLength(1);
      }
      await vi.waitFor(async () =>
        expect((await request(`/approvals/${item.id}`, 'POST', { answer })).response.status).toBe(
          200,
        ),
      );
      await vi.waitFor(async () =>
        expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
          'complete',
        ),
      );
      expect(
        JSON.stringify(calls.at(-1)!.messages.filter((message) => message.role === 'tool')),
      ).toContain(answer);
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity).toMatchObject(
        [
          {
            tool: 'ask',
            action: 'clarification',
            status: 'complete',
            summary: expect.stringContaining(answer),
          },
        ],
      );
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
      expect((await request(`/approvals/${item.id}`, 'POST', { answer })).response.status).toBe(
        409,
      );
      await result;
    },
  );

  it.each([true, false])(
    'waits for explicit approval in Full access and returns approved=%s without a duplicate permission card',
    async (approved) => {
      await configure();
      mode = 'ask-approval';
      const result = chat('Ask permission to publish');
      const item = await pendingApproval('custom-call-1');
      expect(item.ask).toEqual({ action: 'approval', question: 'May I publish this draft?' });
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(1);
      expect(
        (await request(`/approvals/${item.id}`, 'POST', { answer: 'yes' })).response.status,
      ).toBe(400);
      await request(`/approvals/${item.id}`, 'POST', { approved });
      await result;
      const toolMessages = calls.at(-1)!.messages.filter((message) => message.role === 'tool');
      expect(JSON.parse(String(toolMessages[0].content))).toEqual({ action: 'approval', approved });
      expect(
        (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity![0].summary,
      ).toContain(approved ? 'Approved by the user' : 'Denied by the user');
    },
  );

  it('keeps parallel questions separate from tool permissions and rejects bulk clarification grants atomically', async () => {
    await configure();
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'ask-mixed';
    const result = chat('Ask two questions and list browser tabs');
    await pendingApproval('custom-call-3');
    const pending = (await request<ApprovalState>('/approvals')).data.pending;
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((item) => item.batchId)).size).toBe(1);
    const batch = {
      conversationId: pending[0].conversationId,
      batchId: pending[0].batchId,
      ids: pending.map((item) => item.id),
      approved: true,
    };
    expect((await request('/approvals/batch', 'POST', batch)).response.status).toBe(400);
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(3);
    const question = pending.find((item) => item.ask?.action === 'clarification')!;
    const permission = pending.find((item) => item.ask?.action === 'approval')!;
    await request(`/approvals/${question.id}`, 'POST', { answer: 'Existing customers' });
    await vi.waitFor(() =>
      expect(
        api.store.get(
          'SELECT approval_step_json FROM chat_jobs WHERE message_id=?',
          question.messageId,
        )?.approval_step_json,
      ).toContain('Existing customers'),
    );
    // An answered question must not be repeated while its siblings remain pending.
    await api.shutdown();
    await result;
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect(
      (await request<ApprovalState>('/approvals')).data.pending.map((item) => item.id).sort(),
    ).toEqual(
      pending
        .filter((item) => item.id !== question.id)
        .map((item) => item.id)
        .sort(),
    );
    await vi.waitFor(async () =>
      expect(
        (await request(`/approvals/${permission.id}`, 'POST', { approved: false })).response.status,
      ).toBe(200),
    );
    await request(`/approvals/${pending.find((item) => !item.ask)!.id}`, 'POST', {
      approved: true,
    });
    await vi.waitFor(async () =>
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
        'complete',
      ),
    );
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    expect(calls.filter((call) => call.stream)).toHaveLength(2);
  });

  it('executes built-in memory without approval while ask-for-approval is selected', async () => {
    await configure();
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'approval-memory';
    const result = await chat('Search your memory');
    expect(result.events.some((event) => event.type === 'approval')).toBe(false);
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    expect(
      (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity?.[0],
    ).toMatchObject({ tool: 'memory', action: 'search', status: 'complete' });
  });

  it('starts a space mention normally and gates its tool calls with the correct space destination', async () => {
    await configure();
    const space = (
      await request<Conversation>('/conversations', 'POST', {
        workspaceId: 'default',
        name: 'Approval space',
        description: '',
        botIds: ['scout'],
      })
    ).data;
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'raw-tool-once';
    const result = spaceChat(space.id, '@scout check the browser', 'scout');
    for (let i = 0; i < 2; i++) {
      const item = await pendingApproval(`browser-${i}`);
      expect(item).toMatchObject({
        toolName: 'browser',
        botId: 'scout',
        conversationId: space.id,
        target: { kind: 'space', name: 'Approval space', workspaceId: 'default' },
      });
      if (i === 0) {
        await api.shutdown();
        await result;
        await close(api.server);
        api = await startApiServer(0, {
          dataDir: dir,
          memoryExtractor: async () => ({ facts: [] }),
        });
        expect((await request<ApprovalState>('/approvals')).data.pending).toContainEqual(item);
        expect(
          (await request<ChatMessage[]>(`/conversations/${space.id}/messages`)).data[1].status,
        ).toBe('streaming');
      }
      await request(`/approvals/${item.id}`, 'POST', { approved: true });
    }
    await vi.waitFor(async () =>
      expect(
        (await request<ChatMessage[]>(`/conversations/${space.id}/messages`)).data[1].status,
      ).toBe('complete'),
    );
  });
  async function pendingApproval(toolCallId?: string) {
    return vi.waitFor(
      async () => {
        const state = (await request<ApprovalState>('/approvals')).data;
        const item = state.pending.find((item) => !toolCallId || item.toolCallId === toolCallId);
        expect(item).toBeDefined();
        return item!;
      },
      { timeout: 5000, interval: 20 },
    );
  }

  it('authenticates approval endpoints and accepts exactly the two V1 modes', async () => {
    expect((await fetch(api.url + '/approvals')).status).toBe(401);
    expect((await request('/approvals', 'PUT', { mode: 'approve-for-me' })).response.status).toBe(
      400,
    );
    expect((await request('/approvals', 'PUT', { mode: 'ask-for-approval' })).response.status).toBe(
      200,
    );
    expect((await request<ApprovalState>('/approvals')).data.mode).toBe('ask-for-approval');
    expect(
      (await request('/approvals/nonexistent', 'POST', { approved: true })).response.status,
    ).toBe(409);
  });

  it('pauses before every workspace call, resumes one at a time and never writes before approval', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    writeFileSync(join(project, 'notes.txt'), 'Useful notes.');
    await request('/workspaces/default', 'PUT', { name: 'Approval workspace', folder: project });
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'tools';
    const response = chat('Create a draft with approval');
    const observed: string[] = [];
    for (let index = 0; index < 5; index++) {
      const approval = await pendingApproval(`file-call-${index}`);
      observed.push((approval.input as { action: string }).action);
      const before = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      expect(before.status).toBe('streaming');
      expect(before.activity?.length || 0).toBe(index);
      expect(calls).toHaveLength(index + 1);
      if (index === 2) expect(() => readFileSync(join(project, 'draft.md'))).toThrow();
      if (index === 3)
        expect(readFileSync(join(project, 'draft.md'), 'utf8')).toContain('First version.');
      expect(
        (await request(`/approvals/${approval.id}`, 'POST', { approved: true })).response.status,
      ).toBe(200);
      expect(
        (await request(`/approvals/${approval.id}`, 'POST', { approved: true })).response.status,
      ).toBe(409);
    }
    const result = await response;
    expect(result.events.filter((event) => event.type === 'approval')).toHaveLength(10);
    expect(observed).toEqual(['list', 'read_file', 'write_file', 'patch', 'search_files']);
    expect(readFileSync(join(project, 'draft.md'), 'utf8')).toContain('A clearer second version.');
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
  });

  it('gates real custom tools and returns rejection without invoking their code', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Custom approvals', folder: project });
    writeFileSync(
      join(project, 'approval-echo.ts'),
      `export default {name:'approval_echo',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:(args)=>args};`,
    );
    expect(
      (
        await request('/capabilities', 'POST', {
          kind: 'tool',
          operation: 'register',
          modulePath: 'approval-echo.ts',
          ownerBotId: 'scout',
        })
      ).response.status,
    ).toBe(200);
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'approval-custom';
    const rejected = chat('Use my custom tool');
    let approval = await pendingApproval('custom-call-1');
    expect(approval).toMatchObject({ toolName: 'approval_echo', input: { value: 'approved' } });
    expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
    await request(`/approvals/${approval.id}`, 'POST', { approved: false });
    await rejected;
    expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
    expect(
      (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity?.[0],
    ).toMatchObject({ action: 'rejected', status: 'failed' });

    // A conversation created after selection inherits the same system policy.
    const conversation = (await request<Conversation>('/bots/scout/conversations', 'POST', {}))
      .data;
    const approved = privateChat(conversation.id, 'Use the custom tool here');
    approval = await pendingApproval('custom-call-1');
    expect(approval.conversationId).toBe(conversation.id);
    expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
    await request(`/approvals/${approval.id}`, 'POST', { approved: true });
    await approved;
    expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(1);
  });

  it.each(['complete', 'uncertain'] as const)(
    'restores parallel approvals with a %s sibling result and bulk approves only a validated snapshot',
    async (savedState) => {
      await configure();
      project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
      await request('/workspaces/default', 'PUT', { name: 'Parallel approvals', folder: project });
      writeFileSync(
        join(project, 'approval-echo.ts'),
        `export default {name:'approval_echo',description:'Echo',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:(args)=>args};`,
      );
      await request('/capabilities', 'POST', {
        kind: 'tool',
        operation: 'register',
        modulePath: 'approval-echo.ts',
        ownerBotId: 'scout',
      });
      await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
      mode = 'approval-parallel';
      const result = chat('Run three parallel tools');
      await pendingApproval('custom-call-3');
      const pending = (await request<ApprovalState>('/approvals')).data.pending;
      expect(pending).toHaveLength(3);
      expect(new Set(pending.map((item) => item.batchId)).size).toBe(1);
      expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
      const batch = {
        conversationId: pending[0].conversationId,
        batchId: pending[0].batchId,
        ids: pending.map((item) => item.id),
        approved: true,
      };
      expect(
        (
          await fetch(api.url + '/approvals/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
          })
        ).status,
      ).toBe(401);
      expect(
        (await request('/approvals/batch', 'POST', { ...batch, conversationId: 'other-chat' }))
          .response.status,
      ).toBe(409);
      expect(
        (
          await request('/approvals/batch', 'POST', {
            ...batch,
            ids: [pending[0].id, pending[0].id],
          })
        ).response.status,
      ).toBe(400);
      expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
      await request(`/approvals/${pending[0].id}`, 'POST', { approved: true });
      await vi.waitFor(() =>
        expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(1),
      );
      const startedAt = (await request<ChatMessage[]>('/bots/scout/messages')).data[1].startedAt;
      await api.shutdown();
      await result;
      if (savedState === 'uncertain') {
        // Simulate a crash after a side effect but before its output was saved.
        const row = api.store.get(
          'SELECT approval_step_json FROM chat_jobs WHERE message_id=?',
          pending[0].messageId,
        )!;
        const saved = JSON.parse(String(row.approval_step_json));
        saved[0].state = 'running';
        delete saved[0].output;
        api.store.run(
          'UPDATE chat_jobs SET approval_step_json=? WHERE message_id=?',
          JSON.stringify(saved),
          pending[0].messageId,
        );
      }
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1]).toMatchObject({
        status: 'streaming',
        error: null,
        finishedAt: null,
      });
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual(pending.slice(1));
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].startedAt).toBe(
        startedAt,
      );
      expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(1);
      expect(calls.filter((call) => call.stream)).toHaveLength(1);
      expect((await request('/approvals/batch', 'POST', batch)).response.status).toBe(409);
      expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(2);
      expect(
        (await request('/approvals/batch', 'POST', { ...batch, ids: batch.ids.slice(1) })).response
          .status,
      ).toBe(200);
      await vi.waitFor(async () =>
        expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
          'complete',
        ),
      );
      expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(3);
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    },
  );

  it('recovers a pending request after UI disconnect and cancels it on Stop', async () => {
    await configure();
    mode = 'raw-tool-once';
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    const controller = new AbortController();
    const response = await fetch(`${api.url}/bots/scout/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: randomUUID(),
        text: 'Check runtime tools',
        attachmentIds: [],
      }),
    });
    const approval = await pendingApproval();
    controller.abort();
    await response.body?.cancel().catch(() => {});
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([approval]);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity || []).toEqual(
      [],
    );
    await request('/bots/scout/stop', 'POST');
    await vi.waitFor(async () => {
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('stopped');
    });
    expect(
      (await request(`/approvals/${approval.id}`, 'POST', { approved: true })).response.status,
    ).toBe(409);
  });
  it('persists the actual provider failure with chat identifiers and redacts credentials', async () => {
    const provider = await configure();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mode = 'upstream-fail';
    await chat('PRIVATE USER REQUEST - do not log this');
    expect(calls).toHaveLength(6);
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.error).toContain('Could not complete the provider request');
    const path = join(dir, 'logs', 'errors.log');
    const text = readFileSync(path, 'utf8');
    const record = JSON.parse(text.trim());
    expect(record).toMatchObject({
      event: 'chat.failed',
      botId: 'scout',
      conversationId: reply.conversationId,
      messageId: reply.id,
      providerId: provider.id,
      phase: 'provider-request',
      error: {
        name: 'AI_RetryError',
        lastError: {
          name: 'AI_APICallError',
          statusCode: 503,
          providerRequestId: 'fixture-request-42',
          providerError: { code: 'upstream_reset', message: 'Upstream reset [redacted]' },
        },
      },
    });
    expect(text).not.toContain('private-test-key');
    expect(text).not.toContain(api.token);
    expect(text).not.toContain('PRIVATE USER REQUEST');
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect(readFileSync(path, 'utf8')).toBe(text);
    await request(`/providers/${provider.id}/test`, 'POST');
    const records = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      event: 'provider.test_failed',
      error: { name: 'AI_RetryError', lastError: { statusCode: 503 } },
    });
    expect(records).toHaveLength(2);
    expect(calls).toHaveLength(12);
  }, 20000);
  it('records reported token usage, applies model limits, and distinguishes estimates', async () => {
    const provider = await configure();
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      contextWindowTokens: 16384,
      maxOutputTokens: 1024,
    });
    mode = 'usage';
    const sent = await chat('Show usage');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.contextUsage).toMatchObject({
      inputTokens: 2000,
      outputTokens: 100,
      usedTokens: 2100,
      runTokens: 2100,
      contextWindow: 16384,
      estimated: false,
    });
    expect(sent.events.some((event) => event.type === 'context' && !event.usage.estimated)).toBe(
      true,
    );
    expect(calls.at(-1)?.max_tokens).toBe(1024);
    mode = 'normal';
    await chat('Next question');
    expect(
      (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)?.contextUsage,
    ).toMatchObject({ estimated: true, inputTokens: null, contextWindow: 16384 });
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      defaultModel: 'different-model',
    });
    expect(
      (await request<ProviderSettings[]>('/providers')).data[0].contextWindowTokens,
    ).toBeNull();
  });
  it('continues a length-limited generation and preserves the complete visible final answer', async () => {
    await configure();
    mode = 'truncated-once';
    await chat('Long answer');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(2);
    expect(reply.status).toBe('complete');
    expect(reply.content).toBe('First half and the rest.');
    expect(reply.parts?.at(-1)).toMatchObject({ type: 'text', continuationOf: expect.any(String) });
  });
  it('keeps loaded skill instructions in provider context after compaction', async () => {
    const provider = await configure();
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      contextWindowTokens: 16384,
      maxOutputTokens: 1024,
    });
    const skill = api.skills.save('default', {
      files: [
        {
          path: 'SKILL.md',
          encoding: 'utf8',
          content:
            '---\nname: review-workflow\ndescription: Review code.\n---\nAlways check the REVIEW_SKILL_MARKER checklist.',
        },
      ],
    });
    api.skills.load('default', 'scout', 'bot-scout', skill.id);
    await chat('Earlier findings');
    const original = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
    api.store.run(
      'UPDATE messages SET content=? WHERE id=?',
      'Earlier verified findings. '.repeat(3000),
      original.id,
    );
    await chat('Review the latest changes.');
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history.at(-1)?.contextUsage?.compactions).toBeGreaterThan(0);
    expect(
      calls
        .filter((call) => call.stream)
        .at(-1)
        ?.messages.find((message) => message.role === 'system')?.content,
    ).toContain('REVIEW_SKILL_MARKER');
    api.skills.unload('default', 'scout', 'bot-scout', skill.id);
    await chat('Continue without the skill.');
    expect(
      calls
        .filter((call) => call.stream)
        .at(-1)
        ?.messages.find((message) => message.role === 'system')?.content,
    ).not.toContain('REVIEW_SKILL_MARKER');
  });
  it('compacts old history without altering saved messages and reuses its notebook next turn', async () => {
    const provider = await configure();
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      contextWindowTokens: 16384,
      maxOutputTokens: 1024,
    });
    await chat('Earlier findings');
    const original = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
    const evidence = 'Earlier verified finding. '.repeat(3000);
    api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, original.id);
    const sent = await chat('Exact latest goal: review draft.md.');
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].content).toBe(evidence);
    expect(history.at(-1)?.status).toBe('complete');
    expect(history.at(-1)?.contextUsage?.compactions).toBe(1);
    expect(
      sent.events.some((event) => event.type === 'context' && event.usage.phase === 'compacting'),
    ).toBe(true);
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Exact latest goal: review draft.md.');
    expect(
      api.store.get(
        'SELECT summary FROM conversation_contexts WHERE conversation_id=?',
        'bot-scout',
      )?.summary,
    ).toContain('Earlier conversation notes');
    await chat('Follow up');
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Earlier conversation notes');
    expect(JSON.stringify(calls.at(-1)?.messages)).not.toContain(evidence);
  });
  it.each(['compaction-length', 'compaction-empty'] as const)(
    'recovers %s and records an ordered compaction boundary',
    async (failure) => {
      const provider = await configure();
      await request('/providers/' + provider.id, 'PUT', {
        ...provider,
        defaultModel: 'deepseek-flash',
        contextWindowTokens: 32000,
        maxOutputTokens: 8192,
      });
      await chat('Earlier finding');
      const first = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
      const evidence = 'Keep verified evidence. '.repeat(3000);
      api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, first.id);
      mode = failure;
      const sent = await chat('Continue safely');
      const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
      const reply = history.at(-1)!;
      expect(reply.status).toBe('complete');
      expect(history[0].content).toBe(evidence);
      const summaries = calls.filter((call) => !call.stream);
      expect(summaries.length).toBeGreaterThanOrEqual(2);
      expect(summaries[1].max_tokens).toBeGreaterThan(summaries[0].max_tokens!);
      expect(summaries.every((call) => call.thinking?.type === 'disabled')).toBe(true);
      expect(JSON.stringify(reply)).not.toContain('private-test-key');
      const boundary = reply.parts?.find((part) => part.type === 'compaction');
      expect(boundary).toMatchObject({
        state: 'complete',
        tokensAfter: expect.any(Number),
        finishedAt: expect.any(String),
      });
      expect(reply.parts?.at(-1)?.type).toBe('text');
      const states = sent.events.flatMap((event) =>
        event.type === 'part' && event.part.type === 'compaction' ? [event.part.state] : [],
      );
      expect(states).toEqual(['compacting', 'complete']);
    },
  );
  it('leaves usable context and original history intact when compaction fails, then permits retry', async () => {
    const provider = await configure();
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      contextWindowTokens: 16384,
      maxOutputTokens: 1024,
    });
    await chat('Earlier finding');
    const first = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
    const evidence = 'Keep original evidence. '.repeat(3000);
    api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, first.id);
    mode = 'compaction-fail';
    const sent = await chat('Continue exactly from these findings');
    let history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history.at(-1)?.status).toBe('failed');
    expect(history.at(-1)?.error).toContain('compaction did not finish');
    expect(history.at(-1)?.contextUsage?.phase).toBe('failed');
    expect(history.at(-1)?.parts?.at(-1)).toMatchObject({ type: 'compaction', state: 'failed' });
    expect(calls.filter((call) => !call.stream)).toHaveLength(3);
    expect(api.store.all('SELECT * FROM conversation_contexts')).toEqual([]);
    expect(history[0].content).toBe(evidence);
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    mode = 'normal';
    await chat('ignored replacement', sent.requestId);
    history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history).toHaveLength(4);
    expect(history.at(-1)?.status).toBe('complete');
    expect(
      history
        .at(-1)
        ?.parts?.filter((part) => part.type === 'compaction')
        .map((part) => part.state),
    ).toEqual(['failed', 'complete']);
    expect(history[0].content).toBe(evidence);
  });
  it.each(['compaction-filter', 'compaction-slow'] as const)(
    'preserves history when %s interrupts compaction',
    async (failure) => {
      const provider = await configure();
      await request('/providers/' + provider.id, 'PUT', {
        ...provider,
        contextWindowTokens: 16384,
        maxOutputTokens: 1024,
      });
      await chat('Earlier finding');
      const first = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
      const evidence = 'Original evidence. '.repeat(3000);
      api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, first.id);
      mode = failure;
      const running = chat('Continue safely');
      if (failure === 'compaction-slow') {
        await vi.waitFor(() => expect(calls.some((call) => !call.stream)).toBe(true));
        const live = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
        expect(live.parts?.at(-1)).toMatchObject({ type: 'compaction', state: 'compacting' });
        await request('/bots/scout/stop', 'POST');
      }
      await running;
      const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
      expect(history[0].content).toBe(evidence);
      expect(api.store.all('SELECT * FROM conversation_contexts')).toEqual([]);
      expect(calls.filter((call) => !call.stream)).toHaveLength(1);
      expect(history.at(-1)?.parts?.at(-1)).toMatchObject({
        type: 'compaction',
        state: failure === 'compaction-slow' ? 'interrupted' : 'failed',
      });
      expect(history.at(-1)?.status).toBe(failure === 'compaction-slow' ? 'stopped' : 'failed');
    },
  );
  it('handles a provider context rejection with one safe compaction instead of exposing provider text', async () => {
    await configure();
    await chat('Prior context');
    mode = 'overflow';
    await chat('Continue');
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history.at(-1)?.status).toBe('complete');
    expect(history.at(-1)?.contextUsage?.compactions).toBe(1);
    expect(JSON.stringify(history)).not.toContain('private-test-key');
    expect(calls.filter((call) => !call.stream)).toHaveLength(1);
  });
  it.each([0, 2000000])(
    'resumes a completed checkpoint with %i cumulative tokens without replaying its file write',
    async (runTokens) => {
      await configure();
      project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
      const workspace = (
        await request<Workspace>('/workspaces', 'POST', { name: 'Checkpoint', folder: project })
      ).data;
      const bot = (
        await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id })
      ).data;
      mode = 'checkpoint';
      const sent = await chat('Write once, then report.', randomUUID(), bot.id);
      expect(readFileSync(join(project, 'checkpoint.txt'), 'utf8')).toBe('Saved once.');
      expect(api.store.get('SELECT in_flight FROM chat_jobs')?.in_flight).toBe(0);
      api.store.run(
        "UPDATE chat_jobs SET checkpoint_json=json_set(checkpoint_json,'$.usage.runTokens',?,'$.elapsedMs',86400000)",
        runTokens,
      );
      await api.shutdown();
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      mode = 'normal';
      await chat('ignored', sent.requestId, bot.id);
      const history = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data;
      expect(history).toHaveLength(2);
      expect(history[1].status).toBe('complete');
      expect(history[1].contextUsage?.runTokens).toBeGreaterThan(runTokens);
      expect(history[1].activity).toHaveLength(1);
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain('checkpoint.txt');
      expect(calls.at(-1)?.messages.some((message) => message.role === 'tool')).toBe(true);
      expect(api.store.all('SELECT * FROM chat_jobs')).toEqual([]);
    },
  );
  it('carries failed tool work into a fresh message after restart', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'History', folder: project })
    ).data;
    const bot = (await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id }))
      .data;
    mode = 'checkpoint';
    await chat('Write once, then report.', randomUUID(), bot.id);
    expect((await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1].status).toBe(
      'failed',
    );
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    mode = 'normal';
    await chat('Continue the work', randomUUID(), bot.id);
    const context = JSON.stringify(calls.at(-1)?.messages);
    expect(context).toContain('checkpoint.txt');
    expect(context).toContain('Saved once.');
    expect(context).toContain('status: failed');
    expect(readFileSync(join(project, 'checkpoint.txt'), 'utf8')).toBe('Saved once.');
  });
  it('carries stopped partial responses into a fresh message', async () => {
    await configure();
    mode = 'slow';
    const streaming = chat('Slow prompt', randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await request('/bots/scout/stop', 'POST');
    await streaming;
    mode = 'normal';
    await chat('Continue', randomUUID());
    const context = JSON.stringify(calls.at(-1)?.messages);
    expect(context).toContain('A real SDK ');
    expect(context).toContain('status: stopped');
  });
  it('reattaches the same request to a running job without a second model request', async () => {
    await configure();
    mode = 'slow';
    const requestId = randomUUID();
    const response = await fetch(api.url + '/bots/scout/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, text: 'One job', attachmentIds: [] }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await chat('ignored duplicate', requestId);
    expect(calls).toHaveLength(1);
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history).toHaveLength(2);
    expect(history[1].status).toBe('complete');
  });
  it('rejects an oversized pinned request clearly instead of silently truncating it', async () => {
    const provider = await configure();
    await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    });
    const text = 'Exact input '.repeat(1300);
    await chat(text);
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].content).toBe(text.trim());
    expect(history[1].status).toBe('failed');
    expect(history[1].error).toContain('current request');
    expect(calls).toHaveLength(0);
  });
  it.each(['uncertain operation', 'changed workspace folder'])(
    'does not reuse a checkpoint after %s and carries a verification notice',
    async (change) => {
      await configure();
      project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
      const workspace = (
        await request<Workspace>('/workspaces', 'POST', { name: 'Uncertain', folder: project })
      ).data;
      const bot = (
        await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id })
      ).data;
      mode = 'checkpoint';
      const sent = await chat('Write once, then report.', randomUUID(), bot.id);
      if (change === 'uncertain operation') api.store.run('UPDATE chat_jobs SET in_flight=1');
      else {
        const folder = join(project, 'new-scope');
        mkdirSync(folder);
        api.store.run('UPDATE workspaces SET folder=? WHERE id=?', folder, workspace.id);
      }
      await api.shutdown();
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      mode = 'normal';
      await chat('ignored', sent.requestId, bot.id);
      expect(calls.at(-1)?.messages.some((message) => message.role === 'tool')).toBe(false);
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Check before repeating writes');
      expect(readFileSync(join(project, 'checkpoint.txt'), 'utf8')).toBe('Saved once.');
    },
  );
  it('runs terminal, process and browser tools through the shared SDK loop and persists their activity', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Runtime test', folder: project });
    mode = 'runtime-tools';
    await chat('Check the runtime tools');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(message.content).toContain('Verified terminal output');
    expect(
      message.activity?.map((activity) => ({
        tool: activity.tool,
        action: activity.action,
        status: activity.status,
      })),
    ).toEqual([
      { tool: 'terminal', action: 'run', status: 'complete' },
      { tool: 'terminal', action: 'list', status: 'complete' },
      { tool: 'browser', action: 'tabs', status: 'complete' },
    ]);
    expect(message.activity?.[0].summary).toContain('terminal fixture');
    const tools = (await request<ToolInfo[]>('/tools')).data;
    expect(tools.find((tool) => tool.id === 'terminal')).toMatchObject({
      available: true,
      counts: { run: 1, list: 1 },
    });
    expect(tools.find((tool) => tool.id === 'browser')).toMatchObject({
      available: true,
      counts: { tabs: 1 },
    });
    expect((await fetch(api.url + '/browser')).status).toBe(401);
    expect((await request('/browser?workspaceId=default')).data).toEqual([]);
  });
  it('runs the same bot in separate spaces and cancels only the requested conversation', async () => {
    await configure();
    mode = 'slow';
    const create = async (name: string) =>
      (
        await request<Conversation>('/conversations', 'POST', {
          workspaceId: 'default',
          name,
          description: '',
          botIds: ['scout'],
        })
      ).data;
    const first = await create('First'),
      second = await create('Second');
    const start = async (id: string) =>
      fetch(api.url + `/conversations/${id}/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), text: '@scout wait', botId: 'scout' }),
      });
    const firstResponse = await start(first.id),
      secondResponse = await start(second.id);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstBody = firstResponse.text(),
      secondBody = secondResponse.text();
    expect((await start(first.id)).status).toBe(409);
    await request(`/conversations/${first.id}/stop`, 'POST');
    expect(await firstBody).toContain('stopped');
    expect(
      (await request<ChatMessage[]>(`/conversations/${second.id}/messages`)).data.at(-1)!.status,
    ).toBe('streaming');
    await request(`/conversations/${second.id}/stop`, 'POST');
    expect(await secondBody).toContain('stopped');
  });
  it('persists spaces, memberships, bookmarks, and exactly ten isolated context messages', async () => {
    await configure();
    await chat('PRIVATE HISTORY MUST STAY PRIVATE');
    const space = (
      await request<Conversation>('/conversations', 'POST', {
        workspaceId: 'default',
        name: 'Planning',
        description: 'A real space',
        botIds: ['scout'],
      })
    ).data;
    expect(space.botIds).toEqual(['scout']);
    const other = (
      await request<Conversation>('/conversations', 'POST', {
        workspaceId: 'default',
        name: 'Other',
        description: '',
        botIds: [],
      })
    ).data;
    await spaceChat(other.id, 'OTHER SPACE MUST STAY PRIVATE');
    const count = calls.length;
    for (let i = 0; i < 12; i++) await spaceChat(space.id, 'Context ' + i);
    expect(calls.length).toBe(count);
    const sent = await spaceChat(space.id, '@scout hello', 'scout');
    const serialized = JSON.stringify(calls.at(-1)!.messages);
    expect(calls.at(-1)!.messages).toHaveLength(11);
    expect(serialized).toContain('Context 3');
    expect(serialized).not.toContain('Context 2');
    expect(serialized).toContain('[You] @scout hello');
    expect(serialized).not.toContain('MUST STAY PRIVATE');
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(2);
    const history = (await request<ChatMessage[]>(`/conversations/${space.id}/messages`)).data;
    expect(history).toHaveLength(14);
    const reply = history.at(-1)!;
    expect(reply).toMatchObject({
      botId: 'scout',
      conversationId: space.id,
      authorName: 'Scout',
      status: 'complete',
    });
    await request(`/conversations/${space.id}/saved`, 'PUT', { messageId: reply.id, saved: true });
    expect(
      (
        await request(`/conversations/${other.id}/saved`, 'PUT', {
          messageId: reply.id,
          saved: true,
        })
      ).response.status,
    ).toBe(404);
    await spaceChat(space.id, '', 'scout', sent.requestId);
    expect(calls.length).toBe(count + 1);
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<Conversation[]>('/conversations')).data.map((item) => item.id)).toContain(
      space.id,
    );
    expect(
      (await request<ChatMessage[]>(`/conversations/${space.id}/messages`)).data.at(-1)!.saved,
    ).toBe(true);
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('validates space membership, imports local history once, and keeps untagged sends idempotent', async () => {
    expect(
      (
        await request('/conversations', 'POST', {
          workspaceId: 'default',
          name: 'Invalid',
          description: '',
          botIds: ['missing'],
        })
      ).response.status,
    ).toBe(400);
    const input = {
      workspaceId: 'default',
      spaces: [
        {
          id: 'old-space',
          name: 'Old space',
          description: 'Keep me',
          messages: [
            { id: 'old-message', text: 'Saved legacy text', author: 'munashe', saved: true },
          ],
        },
      ],
    };
    const imported = (await request<Conversation[]>('/conversations/import', 'POST', input)).data;
    const again = (await request<Conversation[]>('/conversations/import', 'POST', input)).data;
    expect(again).toEqual(imported);
    const history = (await request<ChatMessage[]>(`/conversations/${imported[0].id}/messages`))
      .data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ content: 'Saved legacy text', saved: true });
    const empty = (
      await request<Conversation>('/conversations', 'POST', {
        workspaceId: 'default',
        name: 'No bots',
        description: '',
        botIds: [],
      })
    ).data;
    const requestId = randomUUID();
    await spaceChat(empty.id, 'Hello', null, requestId);
    await spaceChat(empty.id, 'Hello', null, requestId);
    expect((await request<ChatMessage[]>(`/conversations/${empty.id}/messages`)).data).toHaveLength(
      1,
    );
    expect(
      (
        await request(`/conversations/${empty.id}/chat`, 'POST', {
          requestId: randomUUID(),
          text: '@scout hello',
          botId: 'scout',
        })
      ).response.status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await fetch(api.url + '/conversations')).status).toBe(401);
  });
  it('keeps space artifacts and file diffs scoped to the space that generated them', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    writeFileSync(join(project, 'notes.txt'), 'A note');
    await request('/workspaces/default', 'PUT', { name: 'Files workspace', folder: project });
    const space = (
      await request<Conversation>('/conversations', 'POST', {
        workspaceId: 'default',
        name: 'Files',
        description: '',
        botIds: ['scout'],
      })
    ).data;
    mode = 'tools';
    await spaceChat(space.id, '@scout create a draft', 'scout');
    const history = (await request<ChatMessage[]>(`/conversations/${space.id}/messages`)).data;
    expect(history.at(-1)!.changes).toHaveLength(1);
    expect(
      (await request<FileArtifact[]>(`/conversations/${space.id}/artifacts`)).data[0],
    ).toMatchObject({ path: 'draft.md', messageId: history.at(-1)!.id });
    expect((await request<FileArtifact[]>('/bots/scout/artifacts')).data).toEqual([]);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toEqual([]);
    mode = 'normal';
    await spaceChat(space.id, '@scout followup', 'scout');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('[Scout]');
  });
  it('warns about repeated no-progress calls, then pauses with a tool-free final report', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'Step limit', folder: project })
    ).data;
    const bot = (await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id }))
      .data;
    mode = 'tool-limit';
    const sent = await chat('Work until the limit', randomUUID(), bot.id);
    expect(calls).toHaveLength(10);
    expect(JSON.stringify(calls.slice(5, 9))).toContain('Reassess the approach');
    expect(calls.at(-1)).not.toHaveProperty('tools');
    expect(JSON.stringify(calls.at(-1))).toContain('Tools are now disabled');
    const message = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1];
    expect(message.status).toBe('interrupted');
    expect(message.error).toContain('without progress');
    expect(message.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Final report:'),
    });
    expect(message.activity?.at(-1)?.status).toBe('complete');
    const reasoningEnd = sent.events.find(
      (event) =>
        event.type === 'part' && event.part.type === 'reasoning' && event.part.state === 'complete',
    );
    expect(reasoningEnd).toBeDefined();
    expect(
      message.parts
        ?.filter((part) => part.type === 'reasoning')
        .every((part) => part.state === 'complete'),
    ).toBe(true);
    mode = 'no-final';
    await chat('Try again but return no final answer', randomUUID(), bot.id);
    const incomplete = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data.at(-1)!;
    expect(incomplete.status).toBe('failed');
    expect(incomplete.error).toContain('without a final response');
  });
  it('continues browser work past the previous eight-step ceiling', async () => {
    await configure();
    mode = 'long-browser';
    await chat('Test all browser actions');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(13);
    expect(message.status).toBe('complete');
    expect(message.activity).toHaveLength(12);
    expect(message.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: 'All browser checks finished.',
    });
  });
  // Keep the smaller case close to the catalog's minimum context while leaving
  // room for the image family. The fixture results still greatly exceed it.
  it.each([11000, 28000])(
    'finishes with huge parallel results and an oversized screenshot at %i context',
    async (contextWindowTokens) => {
      const provider = await configure(true);
      await request('/providers/' + provider.id, 'PUT', {
        ...provider,
        contextWindowTokens,
        maxOutputTokens: 8192,
      });
      const original = api.browsers.execute.bind(api.browsers);
      const header = Buffer.alloc(24);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
      header.writeUInt32BE(16000, 16);
      header.writeUInt32BE(16000, 20);
      const image = Buffer.concat([header, Buffer.alloc(1024 * 1024)]).toString('base64');
      vi.spyOn(api.browsers, 'execute').mockImplementation(async (owner, input, signal) => {
        if (input.action === 'snapshot')
          return {
            title: 'Useful page findings',
            url: 'https://example.com',
            controls: [],
            text: 'Useful page findings\n' + '资料🦊'.repeat(100000),
          };
        if (input.action === 'screenshot')
          return {
            summary: 'Captured screenshot.',
            screenshotUrl: '/browser/fixture/screenshot',
            image,
          };
        return original(owner, input, signal);
      });
      mode = 'oversized-results';
      await chat('Read the page, take a screenshot, then give a final report.');
      const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      expect(reply.status, reply.error || undefined).toBe('complete');
      expect(reply.parts?.at(-1)).toMatchObject({
        type: 'text',
        text: 'Large-result browser checks finished.',
      });
      expect(reply.activity).toHaveLength(4);
      expect(
        reply.activity?.filter((activity) => activity.summary.includes(RESULT_TRUNCATED)),
      ).toHaveLength(3);
      const streaming = calls.filter((call) => call.stream);
      expect(streaming).toHaveLength(4);
      for (const call of streaming)
        expect(call.max_tokens).toBeLessThanOrEqual(Math.floor(contextWindowTokens / 8));
      const afterSnapshots = JSON.stringify(streaming[2]);
      expect(afterSnapshots).toContain('Useful page findings');
      expect(afterSnapshots).toContain(RESULT_TRUNCATED);
      expect(afterSnapshots.length).toBeLessThan(contextWindowTokens * 3);
      expect(JSON.stringify(streaming[3])).toContain(IMAGE_OMITTED);
      expect(JSON.stringify(streaming[3])).not.toContain(image);
      const job = api.store.get('SELECT checkpoint_json FROM chat_jobs');
      if (job) expect(String(job.checkpoint_json).length).toBeLessThan(contextWindowTokens * 4);
    },
  );
  it('recovers a textual tool request once while retaining real results and not executing markup', async () => {
    await configure();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mode = 'raw-tool-once';
    const sent = await chat('Continue browser work');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(4);
    expect(message.status).toBe('complete');
    expect(message.activity?.map((activity) => activity.id)).toEqual(['browser-0', 'browser-1']);
    expect(message.content).not.toContain('DSML');
    expect(message.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: 'All browser checks finished.',
    });
    expect(sent.events.filter((event) => event.type === 'start')).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
  });
  it('fails visibly after a second malformed answer without executing its textual invocation', async () => {
    await configure();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mode = 'raw-tool-always';
    await chat('Use the browser');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(2);
    expect(message.status).toBe('failed');
    expect(message.error).toContain('markup was not executed');
    expect(message.activity).toEqual([]);
  });
  it('keeps legacy malformed answers in saved history but does not teach the model their protocol', async () => {
    await configure();
    await chat('Browser checks');
    const malformed =
      'Next, navigate. <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="browser">fake invocation</｜｜DSML｜｜ invoke>';
    const previous = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    api.store.run('UPDATE messages SET content=? WHERE id=?', malformed, previous.id);
    await chat('Continue');
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('DSML');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('That request was not executed');
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].content).toBe(malformed);
  });
  it('does not label a response cut off by its output limit complete', async () => {
    await configure();
    mode = 'truncated';
    await chat('Give a long answer');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(message.status).toBe('failed');
    expect(message.error).toContain('output limit');
  });
  it('saves a failed activity row when SDK validation rejects a tool before execution', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    writeFileSync(join(project, 'notes.txt'), 'Useful notes.');
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'Invalid tool', folder: project })
    ).data;
    const bot = (await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id }))
      .data;
    mode = 'invalid-tool';
    await chat('Create a draft', randomUUID(), bot.id);
    const message = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1];
    expect(message.status).toBe('complete');
    expect(message.activity?.[0]).toMatchObject({
      status: 'failed',
      summary: 'The tool could not run. Check its arguments and try again.',
    });
    expect(
      message.parts?.some(
        (part) => part.type === 'tool' && part.activityId === message.activity?.[0].id,
      ),
    ).toBe(true);
  });
  it('creates folder-backed workspaces with independent Scout bots and persistent chats', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const created = await request<Workspace>('/workspaces', 'POST', {
      name: 'My project',
      folder: project,
    });
    expect(created.response.status).toBe(201);
    expect(created.data.folder).toBe(project);
    const workspaceId = created.data.id;
    const bots = (await request<Bot[]>(`/bots?workspaceId=${workspaceId}`)).data;
    expect(bots).toHaveLength(0);
    bots.push((await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId })).data);
    expect(bots[0].name).toBe('Mukai');
    expect(bots[0].id).not.toBe('scout');
    expect(bots[0].workspaceId).toBe(workspaceId);
    await chat('Only this workspace', randomUUID(), bots[0].id);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(0);
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.id)).toEqual(['scout']);
    expect(
      (await request('/workspaces', 'POST', { name: 'Duplicate', folder: project })).response
        .status,
    ).toBe(409);
    expect(
      (await request('/workspaces', 'POST', { name: 'Private', folder: dir })).response.status,
    ).toBe(400);
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<Workspace[]>('/workspaces')).data).toHaveLength(2);
    expect((await request<Bot[]>(`/bots?workspaceId=${workspaceId}`)).data).toHaveLength(1);
    expect((await request<ChatMessage[]>(`/bots/${bots[0].id}/messages`)).data[0].content).toBe(
      'Only this workspace',
    );
  });
  it('streams actual reasoning and file actions through the SDK, saves artifacts, and replays completed requests without repeating writes', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    writeFileSync(join(project, 'notes.txt'), 'Useful notes for the draft.');
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'Writing', folder: project })
    ).data;
    const bot = (await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id }))
      .data;
    mode = 'tools';
    const sent = await chat('Create a useful draft from my notes', randomUUID(), bot.id);
    expect(sent.events.some((event) => event.type === 'reasoning')).toBe(true);
    expect(sent.events.filter((event) => event.type === 'activity')).toHaveLength(10);
    expect(readFileSync(join(project, 'draft.md'), 'utf8')).toContain('A clearer second version.');
    const messages = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data;
    expect(messages[1].status).toBe('complete');
    expect(messages[1].reasoning).toContain('review the notes');
    expect(messages[1].activity).toHaveLength(5);
    expect(messages[1].activity?.every((item) => item.status === 'complete')).toBe(true);
    expect(messages[1].parts?.map((part) => part.type)).toEqual([
      'reasoning',
      'text',
      'tool',
      'text',
      'tool',
      'text',
      'tool',
      'text',
      'tool',
      'text',
      'tool',
      'text',
    ]);
    expect(
      messages[1].parts?.filter((part) => part.type === 'tool').map((part) => part.activityId),
    ).toEqual(messages[1].activity?.map((activity) => activity.id));
    expect(Date.parse(messages[1].finishedAt!)).toBeGreaterThanOrEqual(
      Date.parse(messages[1].startedAt!),
    );
    const artifacts = (await request<FileArtifact[]>(`/bots/${bot.id}/artifacts`)).data;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].path).toBe('draft.md');
    expect(messages[1].changes).toHaveLength(1);
    const change = messages[1].changes![0];
    expect(change).toMatchObject({ path: 'draft.md', kind: 'created', added: 2, removed: 0 });
    const detail = (await request<FileChangeDetail>(`/changes/${change.id}`)).data;
    expect(detail.before).toBeNull();
    expect(detail.after).toBe('# A useful draft\nA clearer second version.');
    expect(detail.hunks?.flatMap((hunk) => hunk.lines)).toContain('+A clearer second version.');
    // History carries only summaries; snapshots are fetched on demand.
    expect(change).not.toHaveProperty('before');
    expect((await fetch(api.url + `/changes/${change.id}`)).status).toBe(401);
    const count = calls.length;
    await chat('', sent.requestId, bot.id);
    expect(calls).toHaveLength(count);
    expect((await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data).toHaveLength(2);
    const tools = (await request<ToolInfo[]>(`/tools?workspaceId=${workspace.id}`)).data;
    expect(tools[0]).toMatchObject({
      id: 'file_operations',
      scope: 'selected-bots',
      available: true,
      counts: { write_file: 1, patch: 1 },
    });
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    const restored = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1];
    expect(restored.reasoning).toBe(messages[1].reasoning);
    expect(restored.activity).toEqual(messages[1].activity);
    expect(restored.parts).toEqual(messages[1].parts);
    expect(restored.finishedAt).toBe(messages[1].finishedAt);
    expect(restored.changes).toEqual(messages[1].changes);
    writeFileSync(join(project, 'draft.md'), 'Changed outside this turn.');
    expect((await request<FileChangeDetail>(`/changes/${change.id}`)).data).toEqual(detail);
    writeFileSync(join(project, 'draft.md'), detail.after);
    const download = await fetch(api.url + '/artifacts/' + artifacts[0].id, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(await download.text()).toContain('A clearer second version.');
    await request(`/bots/${bot.id}`, 'DELETE');
    expect((await request(`/changes/${change.id}`)).response.status).toBe(404);
    expect(
      (
        await fetch(api.url + '/artifacts/' + artifacts[0].id, {
          headers: { Authorization: `Bearer ${api.token}` },
        })
      ).status,
    ).toBe(404);
    expect(readFileSync(join(project, 'draft.md'), 'utf8')).toContain('A clearer second version.');
  });
  it('connects the existing workspace without replacing its bot or history and disables files until a folder is connected', async () => {
    await configure();
    await chat('Keep my earlier chat');
    expect((await request<ToolInfo[]>('/tools')).data[0].available).toBe(false);
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    expect(
      (
        await request<Workspace>('/workspaces/default', 'PUT', {
          name: 'My original workspace',
          folder: project,
        })
      ).response.status,
    ).toBe(200);
    expect((await request<ToolInfo[]>('/tools')).data[0].available).toBe(true);
    expect((await request<Bot[]>('/bots')).data[0].id).toBe('scout');
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[0].content).toBe(
      'Keep my earlier chat',
    );
    expect(
      (await request('/workspaces/default', 'PUT', { name: 'Changed', folder: project })).response
        .status,
    ).toBe(409);
  });
  it('keeps health public, authenticates API calls, and refuses untrusted origins', async () => {
    const health = await fetch(api.url + '/health');
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toMatchObject({
      status: 'ok',
      service: 'mukai-api',
      version: '0.1.0',
    });
    expect((await fetch(api.url + '/health', { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(api.url + '/health', { method: 'POST' })).status).toBe(405);
    expect((await fetch(api.url + '/missing')).status).toBe(404);
    expect((await fetch(api.url + '/bots')).status).toBe(401);
    expect(
      (
        await fetch(api.url + '/bots', {
          headers: { Authorization: `Bearer ${api.token}`, Origin: 'https://malicious.example' },
        })
      ).status,
    ).toBe(403);
  });
  it('encrypts credentials, masks DTOs, tests a provider, and retains keys on edit', async () => {
    const provider = await configure();
    expect(provider.hasKey).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('private-test-key');
    const row = api.store.get('SELECT encrypted_key FROM providers WHERE id=?', provider.id)!;
    expect(String(row.encrypted_key)).not.toContain('private-test-key');
    expect(readFileSync(join(dir, 'mukai.sqlite')).includes(Buffer.from('private-test-key'))).toBe(
      false,
    );
    expect(
      (
        await request('/providers/' + provider.id, 'PUT', {
          ...provider,
          name: 'Edited',
          apiKey: '',
        })
      ).response.status,
    ).toBe(200);
    const test = await request<{ ok: boolean }>(`/providers/${provider.id}/test`, 'POST');
    expect(test.data.ok).toBe(true);
    mode = 'fail';
    const failure = await request<{ error: string }>(`/providers/${provider.id}/test`, 'POST');
    expect(failure.response.status).toBe(502);
    expect(failure.data.error).not.toContain('private-test-key');
    expect(failure.data.error).toContain('credentials');
  });
  it('persists manually created bots and independent chats, and honors each bot’s instructions and model', async () => {
    const provider = await configure();
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.name)).toEqual(['Scout']);
    const bot = (
      await request<Bot>('/bots', 'POST', {
        name: 'Writer',
        role: 'Writer',
        instructions: 'Write in short sentences.',
        providerId: provider.id,
        model: 'writer-model',
        supportsImages: false,
        avatar: 'nova',
      })
    ).data;
    await chat('First Scout message');
    await chat('First Writer message', randomUUID(), bot.id);
    expect(calls[1].model).toBe('writer-model');
    expect(calls[1].messages[0]).toEqual({
      role: 'system',
      content: expect.stringMatching(/^No current pursuits\n/),
    });
    const writerSystem = String(calls[1].messages[0].content);
    expect(writerSystem).toContain('You are an intelligent assistant operating inside Mukai');
    expect(writerSystem).toContain(
      JSON.stringify({
        id: bot.id,
        name: 'Writer',
        role: 'Writer',
        isMain: false,
        createdBy: 'scout',
      }),
    );
    expect(writerSystem).toContain('Write in short sentences.\nCurrent UTC time: ');
    expect(writerSystem).toContain(
      "If you don't have a tool to do something you can literally make/suggest to make it.",
    );
    expect((await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data).toHaveLength(2);
    await api.shutdown();
    await close(api.server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].content).toBe(
      'A real SDK response.',
    );
    expect((await request<Bot[]>('/bots')).data).toHaveLength(2);
    expect(api.store.all('SELECT version FROM schema_migrations ORDER BY version')).toEqual(
      migrations.map((_sql, index) => ({ version: index + 1 })),
    );
    expect((await request('/bots/scout', 'DELETE')).response.status).toBe(409);
    await request(`/bots/${bot.id}`, 'DELETE');
    await request('/bots/scout', 'DELETE');
    await api.shutdown();
    await close(api.server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<Bot[]>('/bots')).data).toEqual([]);
  });
  it('uses private conversation history beyond ten messages while keeping the full history visible', async () => {
    await configure();
    for (let index = 0; index < 7; index++) await chat(`Prompt ${index}`);
    const latest = calls.at(-1)!;
    expect(latest.messages).toHaveLength(14); // System instructions plus thirteen messages.
    expect(latest.messages.at(-1)).toEqual({ role: 'user', content: 'Prompt 6' });
    expect(JSON.stringify(latest.messages)).toContain('Prompt 0');
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(14);
  });
  it('creates separate chats for one bot with isolated context, titles, retries, and persisted history', async () => {
    await configure();
    await chat('Legacy history stays here');
    const first = (await request<Conversation>('/bots/scout/conversations', 'POST')).data;
    const repeated = await Promise.all([
      request<Conversation>('/bots/scout/conversations', 'POST'),
      request<Conversation>('/bots/scout/conversations', 'POST'),
    ]);
    expect(repeated.map((result) => result.data.id)).toEqual([first.id, first.id]);
    expect(first).toMatchObject({
      name: 'New conversation',
      kind: 'private',
      ownerBotId: 'scout',
      botIds: ['scout'],
    });
    expect((await request<ChatMessage[]>(`/conversations/${first.id}/messages`)).data).toEqual([]);
    const requestId = randomUUID();
    await privateChat(first.id, 'Only first conversation knows this', requestId);
    const second = (await request<Conversation>('/bots/scout/conversations', 'POST')).data;
    expect(second.id).not.toBe(first.id);
    await privateChat(second.id, 'Second conversation starts clean', requestId);
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('Only first conversation');
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('Legacy history');
    const callsBefore = calls.length;
    await privateChat(first.id, '', requestId);
    expect(calls).toHaveLength(callsBefore);
    const messages = (await request<ChatMessage[]>(`/conversations/${first.id}/messages`)).data;
    expect(messages).toHaveLength(2);
    expect(
      (
        await request(`/conversations/${first.id}/saved`, 'PUT', {
          messageId: messages[1].id,
          saved: true,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(`/conversations/${second.id}/saved`, 'PUT', {
          messageId: messages[1].id,
          saved: true,
        })
      ).response.status,
    ).toBe(404);
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    const chats = (await request<Conversation[]>('/conversations?kind=private')).data;
    expect(chats).toHaveLength(3);
    expect(chats.find((item) => item.id === first.id)?.name).toBe(
      'Only first conversation knows this',
    );
    expect(chats.find((item) => item.id === second.id)?.name).toBe(
      'Second conversation starts clean',
    );
    expect(
      (await request<ChatMessage[]>(`/conversations/${first.id}/messages`)).data[1].saved,
    ).toBe(true);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(2);
    expect((await request<Conversation[]>('/conversations')).data).toEqual([]);
    expect((await request('/bots/missing/conversations', 'POST')).response.status).toBe(404);
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('keeps pending uploads and generated artifacts scoped to their private conversation', async () => {
    await configure();
    await chat('Existing bot history');
    const first = (await request<Conversation>('/bots/scout/conversations', 'POST')).data;
    await privateChat(first.id, 'First conversation');
    const second = (await request<Conversation>('/bots/scout/conversations', 'POST')).data;
    const uploaded = await fetch(`${api.url}/conversations/${first.id}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'X-Filename': 'private-note.txt' },
      body: 'Private attachment context',
    });
    expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()) as Attachment;
    expect(
      (await request<Attachment[]>(`/conversations/${first.id}/attachments`)).data,
    ).toHaveLength(1);
    expect((await request<Attachment[]>(`/conversations/${second.id}/attachments`)).data).toEqual(
      [],
    );
    expect((await request<Attachment[]>('/bots/scout/attachments')).data).toEqual([]);
    expect(
      (
        await request(`/conversations/${second.id}/chat`, 'POST', {
          requestId: randomUUID(),
          text: 'Wrong conversation',
          attachmentIds: [file.id],
        })
      ).response.status,
    ).toBe(400);
    expect((await request<ChatMessage[]>(`/conversations/${second.id}/messages`)).data).toEqual([]);
    await privateChat(first.id, 'Read my attachment', randomUUID(), [file.id]);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('Private attachment context');
    expect((await request<Attachment[]>(`/conversations/${first.id}/attachments`)).data).toEqual(
      [],
    );
    await privateChat(second.id, 'A clean message');
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('Private attachment context');
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const workspace = (
      await request<Workspace>('/workspaces/default', 'PUT', { name: 'Test', folder: project })
    ).data;
    expect(workspace.folder).toBe(project);
    mode = 'tools';
    await privateChat(first.id, 'Write and verify a draft');
    expect(
      (await request<FileArtifact[]>(`/conversations/${first.id}/artifacts`)).data,
    ).toHaveLength(1);
    expect((await request<FileArtifact[]>(`/conversations/${second.id}/artifacts`)).data).toEqual(
      [],
    );
  });
  it('preserves user messages on failure and retries the same turn without duplicates', async () => {
    const log = vi.spyOn(console, 'error');
    await configure();
    mode = 'fail';
    const id = randomUUID();
    await chat('Keep this prompt', id);
    let messages = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(messages).toHaveLength(2);
    expect(messages[1].status).toBe('failed');
    expect(messages[1].error).not.toContain('private-test-key');
    mode = 'normal';
    await chat('', id);
    await chat('', id);
    messages = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Keep this prompt');
    expect(messages[1].status).toBe('complete');
    expect(calls).toHaveLength(2);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-test-key');
    expect(
      JSON.parse(String(log.mock.calls[0][0]).replace('[mukai diagnostic] ', '')).error.statusCode,
    ).toBe(401);
  });
  it('stops generation, saves partial text, and retries in the same assistant record', async () => {
    await configure();
    mode = 'slow';
    const id = randomUUID();
    const streaming = chat('Slow prompt', id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await request('/bots/scout/stop', 'POST');
    await streaming;
    const messages = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(messages[1].status).toBe('stopped');
    expect(messages[1].content).toBe('A real SDK ');
    mode = 'normal';
    await chat('', id);
    const retried = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(retried).toHaveLength(2);
    expect(retried[1].id).toBe(messages[1].id);
    expect(retried[1].status).toBe('complete');
  });
  it('persists attachments, sends extracted text, and checks image capabilities before accepting a turn', async () => {
    await configure();
    const file = await upload('notes.md', Buffer.from('A durable document about Mukai.'));
    expect(file.response.status).toBe(201);
    await chat('Read these notes', randomUUID(), 'scout', [file.data.id]);
    expect(JSON.stringify(calls[0].messages)).toContain('A durable document about Mukai.');
    const saved = (await request<ChatMessage[]>('/bots/scout/messages')).data[0].attachments[0];
    expect(saved.id).toBe(file.data.id);
    const download = await fetch(api.url + '/attachments/' + saved.id, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    expect(await download.text()).toBe('A durable document about Mukai.');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const image = await upload('picture.png', png);
    const rejected = await request('/bots/scout/chat', 'POST', {
      requestId: randomUUID(),
      text: 'Look',
      attachmentIds: [image.data.id],
    });
    expect(rejected.response.status).toBe(400);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(2);
    const provider = (await request<ProviderSettings[]>('/providers')).data[0];
    await request(`/providers/${provider.id}`, 'PUT', { ...provider, supportsImages: true });
    await chat('Look', randomUUID(), 'scout', [image.data.id]);
    expect(JSON.stringify(calls.at(-1))).toContain('data:image/png;base64');
    expect((await upload('program.exe', Buffer.from('MZbinary'))).response.status).toBe(400);
    expect((await upload('fake.png', Buffer.from('not an image'))).response.status).toBe(400);
  });
  it('marks unfinished responses interrupted on startup and enforces provider references and bot deletion', async () => {
    const provider = await configure();
    const bot = (
      await request<Bot>('/bots', 'POST', {
        name: 'Temporary',
        role: 'Assistant',
        instructions: 'Be useful.',
        providerId: provider.id,
        model: null,
        supportsImages: null,
        avatar: 'atlas',
      })
    ).data;
    expect((await request(`/providers/${provider.id}`, 'DELETE')).response.status).toBe(409);
    const file = await upload('temporary.txt', Buffer.from('Temporary file'), bot.id);
    await chat('Read', randomUUID(), bot.id, [file.data.id]);
    api.store.run(
      "UPDATE messages SET status='streaming' WHERE bot_id=? AND role='assistant'",
      bot.id,
    );
    await api.shutdown();
    await close(api.server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    expect((await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1].status).toBe(
      'interrupted',
    );
    expect((await request(`/bots/${bot.id}`, 'DELETE')).response.status).toBe(200);
    expect((await request(`/attachments/${file.data.id}`)).response.status).toBe(404);
    expect((await request(`/providers/${provider.id}`, 'DELETE')).response.status).toBe(200);
  });
  it('extracts readable PDF and DOCX content with visible extraction notices', async () => {
    await configure();
    const pdf = await upload('notes.pdf', pdfFixture());
    const docx = await upload('notes.docx', docxFixture());
    expect(pdf.response.status).toBe(201);
    expect(pdf.data.warning).toContain('first 20 pages');
    expect(docx.response.status).toBe(201);
    expect(docx.data.warning).toContain('Formatting');
    await chat('Read the documents', randomUUID(), 'scout', [pdf.data.id, docx.data.id]);
    expect(JSON.stringify(calls[0])).toContain('Readable PDF note');
    expect(JSON.stringify(calls[0])).toContain('Readable DOCX note');
  });
  it('recovers pending files, applies size/type/count limits, and warns before text truncation', async () => {
    const file = await upload('long.txt', Buffer.from('x'.repeat(25000)));
    expect(file.data.warning).toContain('24,000');
    expect((await request<Attachment[]>('/bots/scout/attachments')).data[0].id).toBe(file.data.id);
    expect((await upload('invalid.txt', Buffer.from([0xff, 0xfe, 0x00]))).response.status).toBe(
      400,
    );
    expect((await upload('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1))).response.status).toBe(
      413,
    );
    for (let i = 0; i < 3; i++)
      expect((await upload(`file${i}.txt`, Buffer.from('text'))).response.status).toBe(201);
    expect((await upload('fifth.txt', Buffer.from('text'))).response.status).toBe(400);
    await request(`/attachments/${file.data.id}`, 'DELETE');
    expect((await request<Attachment[]>('/bots/scout/attachments')).data).toHaveLength(3);
  });
  it('handles disconnected streams and prevents concurrent requests or duplicate backend ownership', async () => {
    await configure();
    mode = 'slow';
    await expect(
      startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) }),
    ).rejects.toThrow('Another Mukai backend');
    const response = await fetch(api.url + '/bots/scout/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), text: 'Keep me', attachmentIds: [] }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    expect(
      (
        await request('/bots/scout/chat', 'POST', {
          requestId: randomUUID(),
          text: 'Concurrent',
          attachmentIds: [],
        })
      ).response.status,
    ).toBe(409);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('streaming');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const messages = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Keep me');
    expect(messages[1].status).toBe('complete');
    expect(calls).toHaveLength(1);
  });
  it('saves all supported provider types and keeps exactly one workspace default', async () => {
    for (const kind of ['openai', 'anthropic', 'google'] as const) {
      const saved = await request<ProviderSettings>('/providers', 'POST', {
        name: kind,
        kind,
        baseUrl: '',
        defaultModel: 'user-chosen-model',
        supportsImages: true,
        isDefault: true,
        apiKey: 'not-a-live-key',
      });
      expect(saved.response.status).toBe(201);
      expect(saved.data.hasKey).toBe(true);
      expect(JSON.stringify(saved.data)).not.toContain('not-a-live-key');
    }
    const providers = (await request<ProviderSettings[]>('/providers')).data;
    expect(providers.filter((provider) => provider.isDefault)).toHaveLength(1);
    expect(providers.find((provider) => provider.isDefault)?.kind).toBe('google');
    expect(
      (
        await request('/providers', 'POST', {
          name: 'Unsafe',
          kind: 'compatible',
          baseUrl: 'http://remote.example/v1',
          defaultModel: 'test',
          supportsImages: false,
          isDefault: false,
        })
      ).response.status,
    ).toBe(400);
  });
});
