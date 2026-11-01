import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  SavedProviderModel,
  Attachment,
  Workspace,
  FileArtifact,
  ToolInfo,
} from '../shared/ai';
import type { FileChangeDetail } from '../shared/fileChanges';
import type { Conversation } from '../shared/conversations';
import { IMAGE_OMITTED, RESULT_TRUNCATED } from './services/toolResultPolicy';
import { approvalReviewNotice, type ApprovalState } from '../shared/approvals';
import { mukaiEnvironmentInstructions } from '../shared/botSystemPrompt';
import { ArtifactRepository } from './repositories/artifactRepository';
import { ProviderService } from './services/providerService';
import { wavFixture, mp4Fixture } from './testMediaFixtures';

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
  tools?: unknown[];
  thinking?: { type: string };
}[];
let mode:
  | 'normal'
  | 'fail'
  | 'media-rejected'
  | 'media-tools'
  | 'media-tools-rejected'
  | 'upstream-fail'
  | 'transient-stream'
  | 'transient-stream-always'
  | 'buffered-tool'
  | 'watchdog-once'
  | 'watchdog-always'
  | 'watchdog-stop'
  | 'watchdog-approval'
  | 'malformed-stream'
  | 'malformed-stream-always'
  | 'malformed-stream-with-tool'
  | 'malformed-stream-after-tool'
  | 'incomplete-stream'
  | 'malformed-http'
  | 'malformed-stream-stop'
  | 'reasoning-echo-once'
  | 'reasoning-echo-always'
  | 'reasoning-echo-stop'
  | 'reasoning-echo-answer'
  | 'reasoning-echo-stale'
  | 'reasoning-echo-approval'
  | 'memory-failure'
  | 'slow'
  | 'tools'
  | 'invalid-tool'
  | 'tool-limit'
  | 'tool-limit-echo'
  | 'no-final'
  | 'truncated'
  | 'truncated-once'
  | 'usage'
  | 'compaction-fail'
  | 'compaction-invalid'
  | 'compaction-overflow'
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
  | 'attachment-tools'
  | 'artifact-feedback'
  | 'screenshot-artifact'
  | 'approval-custom'
  | 'approval-registration'
  | 'approval-parallel'
  | 'ask-clarification'
  | 'ask-approval'
  | 'ask-mixed'
  | 'autonomous-update'
  | 'approval-memory' = 'normal';
let endpoint = '';
let project = '';
let artifactFeedbackId = '';
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
async function configure(vision = false, model: Partial<SavedProviderModel> = {}) {
  const savedModel: SavedProviderModel = {
    id: 'test-chat',
    name: 'Test chat',
    // Tool-loop fixtures count retained results. Compaction scenarios set their own smaller limits.
    contextWindowTokens: 65536,
    maxOutputTokens: 8192,
    supportsImages: vision,
    ...model,
  };
  const result = await request<ProviderSettings>('/providers', 'POST', {
    name: 'Local test',
    kind: 'compatible',
    baseUrl: endpoint,
    defaultModel: savedModel.id,
    models: [savedModel],
    supportsImages: savedModel.supportsImages,
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
  let screenshotStep = 0;
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (mode === 'media-tools' || mode === 'media-tools-rejected') {
      const completed = body.messages.some((message: { role: string }) => message.role === 'tool');
      if (
        mode === 'media-tools-rejected' &&
        /input_audio|video_url/.test(JSON.stringify(body.messages))
      ) {
        res
          .writeHead(415, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Unsupported media codec private-test-key' } }));
        return;
      }
      const delta = completed
        ? { content: 'Media inspection finished.' }
        : {
            tool_calls: ['audio', 'video'].map((kind, index) => ({
              index,
              id: 'inspect-' + kind,
              type: 'function',
              function: {
                name: 'media',
                arguments: JSON.stringify({
                  action: kind === 'audio' ? 'listen_audio' : 'view_video',
                  path: join(dir, kind === 'audio' ? 'outside.wav' : 'outside.mp4'),
                }),
              },
            })),
          };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'media-tools', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: completed ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (mode === 'media-rejected' && /input_audio|video_url/.test(JSON.stringify(body.messages))) {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'Unsupported audio codec private-test-key' } }));
      return;
    }
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
    if (['overflow', 'compaction-overflow'].includes(mode) && body.stream && !overflowed) {
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
                    : ['compaction-invalid', 'compaction-overflow'].includes(mode)
                      ? JSON.stringify([
                          {
                            sourceId: 'not-a-source',
                            note: 'Invented summary',
                            quote: 'Unobserved result',
                          },
                        ])
                      : JSON.stringify(body.messages).includes('Summarize working memory')
                        ? (() => {
                            const sources = JSON.parse(String(body.messages.at(-1)?.content)) as {
                              id: string;
                              text: string;
                              evidence?: string;
                            }[];
                            const findings =
                              mode === 'oversized-results'
                                ? ['Useful page findings', RESULT_TRUNCATED, IMAGE_OMITTED].filter(
                                    (finding) =>
                                      sources.some((source) => source.text.includes(finding)),
                                  )
                                : [];
                            return JSON.stringify(
                              findings.length
                                ? findings.map((finding) => ({
                                    sourceId: sources.find((source) =>
                                      source.text.includes(finding),
                                    )!.id,
                                    note: 'Saved work.',
                                    quote: finding,
                                  }))
                                : [
                                    {
                                      sourceId: sources[0].id,
                                      note:
                                        mode === 'oversized-results'
                                          ? 'Saved work.'
                                          : 'Earlier conversation notes: retain source provenance.',
                                      quote: (sources[0].evidence ?? sources[0].text).slice(0, 16),
                                    },
                                  ],
                            );
                          })()
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
    if (mode === 'malformed-http' && calls.filter((call) => call.stream).length === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: { code: 'invalid_tool_call', message: 'PRIVATE_PROVIDER_PAYLOAD' },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (
      [
        'malformed-stream',
        'malformed-stream-always',
        'malformed-stream-with-tool',
        'malformed-stream-after-tool',
        'incomplete-stream',
        'malformed-stream-stop',
      ].includes(mode)
    ) {
      const streamCalls = calls.filter((call) => call.stream).length;
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'malformed-fixture', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      const delivered = body.messages.some((message: { role: string }) => message.role === 'tool');
      if (
        (mode === 'malformed-stream-with-tool' && streamCalls <= 2) ||
        (!delivered && mode === 'malformed-stream-after-tool')
      ) {
        send({
          tool_calls: [
            {
              index: 0,
              id:
                mode === 'malformed-stream-with-tool' && streamCalls === 1
                  ? 'not-dispatched'
                  : 'write-once',
              type: 'function',
              function: {
                name: 'file_operations',
                arguments: JSON.stringify({
                  action: 'write_file',
                  path: 'once.txt',
                  content: 'Written once.',
                }),
              },
            },
          ],
        });
        if (mode === 'malformed-stream-after-tool' || streamCalls === 2) {
          send({}, 'tool_calls');
          res.end('data: [DONE]\n\n');
          return;
        }
      }
      const shouldFail =
        mode === 'malformed-stream-always' ||
        (mode === 'malformed-stream-after-tool' ? streamCalls === 2 : streamCalls === 1);
      if (shouldFail) {
        send({ content: 'I found the defect; fixing the pending/tickets mismatch next.' });
        if (mode === 'malformed-stream-stop') {
          const timer = setTimeout(
            () =>
              res.end(
                `data: ${JSON.stringify({
                  error: {
                    code: 'invalid_tool_call',
                    message: 'Malformed tool call.',
                  },
                })}\n\ndata: [DONE]\n\n`,
              ),
            200,
          );
          res.once('close', () => clearTimeout(timer));
          return;
        }
        res.end(
          `data: ${JSON.stringify({
            error: {
              code: mode === 'incomplete-stream' ? 'incomplete_tool_call' : 'invalid_tool_call',
              type: 'server_error',
              message: 'Model output contains an unrecoverable tool call. PRIVATE_PROVIDER_PAYLOAD',
            },
          })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
    }
    if (mode === 'buffered-tool' || mode.startsWith('watchdog-')) {
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'watchdog-fixture', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      const completed = body.messages.filter(
        (message: { role: string }) => message.role === 'tool',
      ).length;
      const recovering = JSON.stringify(body.messages).includes(
        'Mukai ended the previous generation at its response time limit',
      );
      const invoke = (name: string, input: unknown) =>
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: 'watchdog-tool-' + completed,
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          'tool_calls',
        );
      if (mode === 'watchdog-stop') {
        send({ content: 'Now writing the renderer.' });
        return;
      }
      if (!completed) {
        send({ content: 'Now writing the renderer.' });
        const write = () => {
          invoke('file_operations', {
            action: 'write_file',
            path: 'once.txt',
            content: 'Saved once.',
          });
          res.end('data: [DONE]\n\n');
        };
        if (mode === 'buffered-tool') {
          // Like oMLX, send commentary, then buffer the entire tool call.
          const timer = setTimeout(write, 1500);
          res.once('close', () => clearTimeout(timer));
        } else write();
        return;
      }
      if (mode === 'buffered-tool' || (completed >= 2 && mode === 'watchdog-once')) {
        send({ content: 'Finished using the saved file.' }, 'stop');
      } else if (recovering && mode === 'watchdog-approval' && completed === 1) {
        invoke('communicate', { action: 'approval', question: 'May I publish this draft?' });
      } else if (recovering && mode === 'watchdog-once') {
        invoke('file_operations', { action: 'read_file', path: 'once.txt' });
      } else {
        send({ content: 'Now completing the remaining renderer work.' });
        // This incomplete argument stream must never enter the next request as a call.
        send({
          tool_calls: [
            {
              index: 0,
              id: 'unfinished-write',
              type: 'function',
              function: {
                name: 'file_operations',
                arguments: '{"action":"write_file","path":"never.txt","content":"',
              },
            },
          ],
        });
        return;
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'transient-stream-always' || (mode === 'transient-stream' && calls.length === 1)) {
      res.end(
        'data: ' +
          JSON.stringify({
            error: {
              message: 'Our servers are currently overloaded. Please try again later.',
              code: 'server_is_overloaded',
              type: 'server_error',
            },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (
      mode === 'memory-failure' &&
      !body.messages.some((message: { role: string }) => message.role === 'tool')
    ) {
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'memory-failure',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'memory-save',
                      type: 'function',
                      function: {
                        name: 'memory',
                        arguments: JSON.stringify({
                          action: 'add',
                          content: 'User prefers coffee.',
                          scope: 'workspace',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (mode === 'screenshot-artifact') {
      // Compaction can remove completed tool messages; fixture progress must survive it.
      const step = screenshotStep++;
      const sessionId = api.browsers.list('default')[0]?.id;
      const steps = [
        { name: 'browser', input: { action: 'open', url: 'https://example.com' } },
        { name: 'browser', input: { action: 'screenshot', sessionId } },
        { name: 'browser', input: { action: 'screenshot', sessionId } },
        { name: 'browser', input: { action: 'close', sessionId } },
        {
          name: 'media',
          input: {
            action: 'view_image',
            path:
              api.store.get('SELECT path FROM artifacts ORDER BY created_at DESC LIMIT 1')?.path ||
              '',
          },
        },
      ];
      const action = steps[step];
      const delta = action
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'capture-' + step,
                type: 'function',
                function: { name: action.name, arguments: JSON.stringify(action.input) },
              },
            ],
          }
        : { content: 'Saved and reinspected screenshot artifacts.' };
      res.write(
        `data: ${JSON.stringify({ id: 'capture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (
      mode === 'autonomous-update' &&
      !body.messages.some((message: { role: string }) => message.role === 'tool')
    ) {
      const delta = {
        tool_calls: [
          {
            index: 0,
            id: 'autonomous-notify',
            type: 'function',
            function: {
              name: 'communicate',
              arguments: JSON.stringify({
                action: 'notify',
                title: 'Review ready',
                message: 'I verified the result and it is ready for review.',
              }),
            },
          },
        ],
      };
      res.write(
        `data: ${JSON.stringify({ id: 'notify', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'artifact-feedback') {
      const invalid = body.messages.some(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'invalid-artifact-kind',
      );
      const refused = body.messages.some(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'read-image-text',
      );
      const delta = refused
        ? { content: 'Use media.view_image to inspect the image pixels.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: invalid ? 'read-image-text' : 'invalid-artifact-kind',
                type: 'function',
                function: {
                  name: 'conversations',
                  arguments: JSON.stringify(
                    invalid
                      ? { action: 'read_artifact', attachmentId: artifactFeedbackId }
                      : { action: 'list_artifacts', kind: 'image' },
                  ),
                },
              },
            ],
          };
      res.write(
        `data: ${JSON.stringify({ id: 'feedback', model: body.model, choices: [{ index: 0, delta, finish_reason: refused ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'attachment-tools') {
      const discovery = body.messages.find(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'discover-upload',
      );
      const viewed = body.messages.some(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'reopen-upload',
      );
      const copied = body.messages.some(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'copy-upload',
      );
      const attachmentId = discovery ? JSON.parse(discovery.content).results[0].id : undefined;
      const delta = copied
        ? { content: 'Reopened and copied the saved upload.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: !discovery ? 'discover-upload' : !viewed ? 'reopen-upload' : 'copy-upload',
                type: 'function',
                function: {
                  name: !discovery ? 'conversations' : !viewed ? 'media' : 'file_operations',
                  arguments: JSON.stringify(
                    !discovery
                      ? {
                          action: 'search_artifacts',
                          source: 'attachment',
                          query: 'reference.png',
                          limit: 1,
                        }
                      : !viewed
                        ? { action: 'view_image', attachmentId }
                        : {
                            action: 'copy_attachment',
                            attachmentId,
                            path: join(project, 'copied.png'),
                          },
                  ),
                },
              },
            ],
          };
      res.write(
        `data: ${JSON.stringify({ id: 'attachments', model: body.model, choices: [{ index: 0, delta, finish_reason: copied ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
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
                  name: 'media',
                  arguments: JSON.stringify({
                    action: 'view_image',
                    path: join(dir, 'outside.png'),
                  }),
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
      mode === 'approval-registration' ||
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
                                ? 'communicate'
                                : mode === 'approval-memory'
                                  ? 'memory'
                                  : mode === 'approval-registration'
                                    ? 'register_custom_tool'
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
                                    : mode === 'approval-registration'
                                      ? '{"operation":"register","modulePath":"approval-echo.ts","permissionMode":"user_approval"}'
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
    if (mode.startsWith('reasoning-echo-')) {
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'echo-fixture', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      const completed = body.messages.filter(
        (message: { role: string }) => message.role === 'tool',
      ).length;
      const recovering = JSON.stringify(body.messages).includes(
        'Your previous response repeated your reasoning',
      );
      const invoke = (name: string, input: unknown) => {
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: 'echo-tool-' + completed,
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          'tool_calls',
        );
      };
      if (mode === 'reasoning-echo-answer') {
        send({ reasoning_content: '42' });
        send({ content: '42' }, 'stop');
      } else if (mode === 'reasoning-echo-stop') {
        send({ reasoning_content: 'Continue.' });
        send({ content: 'Continue.' });
        const timer = setTimeout(() => {
          send({}, 'stop');
          res.end('data: [DONE]\n\n');
        }, 200);
        res.once('close', () => clearTimeout(timer));
        return;
      } else if (!completed) {
        // An echo in a tool-bearing step must not be mistaken for a final reply.
        send({ reasoning_content: 'Continue.' });
        send({ content: 'Continue.' });
        invoke('file_operations', {
          action: 'write_file',
          path: 'once.txt',
          content: 'Saved once.',
        });
      } else if (mode === 'reasoning-echo-stale') {
        send({ content: 'Continue.' }, 'stop');
      } else if (
        mode === 'reasoning-echo-always' ||
        (mode === 'reasoning-echo-approval' && completed > 1) ||
        !recovering
      ) {
        send({ reasoning_content: '\nContinue.' });
        send({ content: 'Continue.\n' }, 'stop');
      } else if (completed === 1) {
        if (mode === 'reasoning-echo-approval')
          invoke('communicate', { action: 'approval', question: 'May I publish this draft?' });
        else invoke('file_operations', { action: 'read_file', path: 'once.txt' });
      } else send({ content: 'Finished the remaining check using saved progress.' }, 'stop');
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
    if (
      ['tools', 'invalid-tool', 'tool-limit', 'tool-limit-echo', 'no-final', 'checkpoint'].includes(
        mode,
      )
    ) {
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
      if (mode === 'tool-limit' || mode === 'tool-limit-echo' || mode === 'no-final') {
        if (!body.tools?.length) {
          if (mode === 'tool-limit-echo') send({ reasoning_content: 'Continue.' });
          send(
            mode === 'no-final'
              ? {}
              : mode === 'tool-limit-echo'
                ? { content: 'Continue.' }
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
          if (method === 'Page.captureScreenshot')
            return {
              data: (
                await sharp({
                  create: { width: 30, height: 20, channels: 3, background: '#0088cc' },
                })
                  .png()
                  .toBuffer()
              ).toString('base64'),
            };
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
  it('streams live events for clients that ask for event-stream and keeps newline JSON for the rest', async () => {
    await configure();
    // Intermediaries such as CDNs buffer a plain body until the response ends,
    // so a browser asking for text/event-stream must get real SSE frames.
    const sse = await fetch(`${api.url}/bots/scout/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ requestId: randomUUID(), text: 'Stream live', attachmentIds: [] }),
    });
    const sseBody = await sse.text();
    expect(sse.status, sseBody).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const frames = sseBody
      .split('\n\n')
      .filter((block) => block.trim() !== '' && !block.startsWith(':'));
    expect(frames.every((block) => block.startsWith('data: '))).toBe(true);
    const events = frames.map((block) => JSON.parse(block.slice(6)) as ChatEvent);
    expect(events.some((event) => event.type === 'start')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');

    // Older clients parse bare JSON lines; they must keep receiving them.
    const legacy = await fetch(`${api.url}/bots/scout/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), text: 'Plain lines', attachmentIds: [] }),
    });
    expect(legacy.headers.get('content-type')).toContain('application/x-ndjson');
    const plain = (await legacy.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatEvent);
    expect(plain.at(-1)?.type).toBe('done');
  });

  it('waits before screenshot capture and persistence, and rejected captures create no artifact', async () => {
    await configure(true);
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'screenshot-artifact';
    const running = chat('Save approved screenshots only');
    const opened = await pendingApproval('capture-0');
    await request('/approvals/' + opened.id, 'POST', { approved: true });
    const first = await pendingApproval('capture-1');
    expect((await request<FileArtifact[]>('/bots/scout/artifacts')).data).toEqual([]);
    await request('/approvals/' + first.id, 'POST', { approved: true });
    const second = await pendingApproval('capture-2');
    expect((await request<FileArtifact[]>('/bots/scout/artifacts')).data).toHaveLength(1);
    await request('/approvals/' + second.id, 'POST', { approved: false });
    for (const toolCallId of ['capture-3', 'capture-4']) {
      const item = await pendingApproval(toolCallId);
      await request('/approvals/' + item.id, 'POST', { approved: true });
    }
    await running;
    expect((await request<FileArtifact[]>('/bots/scout/artifacts')).data).toHaveLength(1);
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.activity).toMatchObject([
      { action: 'open', status: 'complete' },
      { action: 'screenshot', status: 'complete' },
      { action: 'rejected', status: 'failed' },
      { action: 'close', status: 'complete' },
      { tool: 'media', action: 'view_image', status: 'complete' },
    ]);
  });

  it.each([
    { vision: true, folder: false },
    { vision: true, folder: true },
    { vision: false, folder: false },
  ])(
    'persists unique screenshot artifacts with vision=$vision and folder=$folder after restart',
    async ({ vision, folder }) => {
      // This test checks delivery/persistence; small-window omission is tested separately.
      await configure(vision, { contextWindowTokens: 262144 });
      if (folder) {
        project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
        await request('/workspaces/default', 'PUT', {
          name: 'Screenshot workspace',
          folder: project,
        });
      }
      mode = 'screenshot-artifact';
      await chat('Capture screenshots and inspect the saved image after closing the tab');
      const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      expect(reply.status, reply.error || undefined).toBe('complete');
      const files = (await request<FileArtifact[]>('/bots/scout/artifacts')).data;
      expect(files).toHaveLength(2);
      expect(files[0].path).not.toBe(files[1].path);
      expect(api.browsers.list('default')).toEqual([]);
      for (const file of files) {
        expect(file).toMatchObject({ kind: 'image', mediaType: 'image/png', messageId: reply.id });
        expect(file.path).toContain(
          folder
            ? join(project, '.mukai', 'artifacts', 'screenshots')
            : join(dir, 'artifacts', 'screenshots', 'default'),
        );
        expect(readFileSync(file.path).subarray(1, 4).toString()).toBe('PNG');
        const response = await fetch(api.url + '/artifacts/' + file.id, {
          headers: { Authorization: `Bearer ${api.token}` },
        });
        expect(response.headers.get('Content-Type')).toBe('image/png');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(file.path));
        expect((await fetch(api.url + '/artifacts/' + file.id)).status).toBe(401);
      }
      const privateConversation = (
        await request<Conversation>('/bots/scout/conversations', 'POST', {})
      ).data;
      expect(
        (await request<FileArtifact[]>('/conversations/' + privateConversation.id + '/artifacts'))
          .data,
      ).toEqual([]);
      api.store.run('UPDATE artifacts SET path=? WHERE id=?', join(dir, 'api.token'), files[0].id);
      expect((await request('/artifacts/' + files[0].id)).response.status).toBe(400);
      api.store.run('UPDATE artifacts SET path=? WHERE id=?', files[0].path, files[0].id);
      const screenshots = reply.activity!.filter((item) => item.action === 'screenshot');
      expect(screenshots).toHaveLength(2);
      for (const item of screenshots) {
        expect(item.status, item.summary).toBe('complete');
        expect(JSON.parse(item.summary.split('\n\n')[0])).toMatchObject({
          artifactId: expect.any(String),
          path: expect.any(String),
          width: 30,
          height: 20,
          imageIncluded: vision,
          imageDelivery: vision ? 'included' : 'unsupported',
        });
        expect(item.summary).not.toContain('"image":');
      }
      expect(reply.activity!.at(-1)?.status, reply.activity!.at(-1)?.summary).toBe(
        vision ? 'complete' : 'failed',
      );
      // A later compaction can replace pixels with a summary before the final reply.
      expect(
        calls.some(
          (call) => call.stream && JSON.stringify(call.messages).includes('data:image/png;base64'),
        ),
      ).toBe(vision);
      expect(reply.activity!.at(-1)).toMatchObject({
        tool: 'media',
        status: vision ? 'complete' : 'failed',
      });
      await api.shutdown();
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      expect((await request<FileArtifact[]>('/bots/scout/artifacts')).data).toEqual(files);
      for (const file of files) {
        const response = await fetch(api.url + '/artifacts/' + file.id, {
          headers: { Authorization: `Bearer ${api.token}` },
        });
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(file.path));
      }
    },
  );

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
        expect(item).toMatchObject({ toolName: 'media', input: { action: 'view_image', path } });
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
          tool: 'media',
          action: approved ? 'view_image' : 'rejected',
          status: approved ? 'complete' : 'failed',
        },
      ]);
      const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      const previewUrl = `/conversations/${message.conversationId}/activity-image`;
      const input = { messageId: message.id, activityId: activities![0].id };
      const preview = await fetch(api.url + previewUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(preview.status).toBe(approved ? 200 : 404);
      if (approved) {
        expect(preview.headers.get('content-type')).toBe('image/png');
        expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width).toBe(30);
        expect(
          (await request(previewUrl, 'POST', { ...input, activityId: 'unknown' })).response.status,
        ).toBe(404);
        expect(
          (await request('/conversations/bot-other/activity-image', 'POST', input)).response.status,
        ).toBe(404);
        unlinkSync(path);
        const missing = await request<{ error: string }>(previewUrl, 'POST', input);
        expect(missing.response.status).toBe(404);
        expect(missing.data.error).toContain('This image is no longer available');
      }
      expect((await fetch(api.url + previewUrl, { method: 'POST' })).status).toBe(401);
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    },
  );

  it('serves response references through authenticated conversation-scoped routes', async () => {
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    api.store.run('UPDATE workspaces SET folder=? WHERE id=?', project, 'default');
    writeFileSync(join(project, 'notes.md'), '# Notes\nSecond line');
    const png = await sharp({
      create: { width: 25, height: 15, channels: 3, background: '#0088cc' },
    })
      .png()
      .toBuffer();
    const attachment = (await upload('reference.png', png)).data;
    const preview = (href: string, image = false) =>
      fetch(api.url + '/conversations/bot-scout/reference', {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ href, image }),
      });
    expect((await preview(`mukai://attachment/${attachment.id}`)).status).toBe(404);
    api.store.run(
      "INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('reference-message','scout','bot-scout','reference','user','','complete','2026-10-24')",
    );
    api.store.run(
      'UPDATE attachments SET message_id=? WHERE id=?',
      'reference-message',
      attachment.id,
    );
    const file = new ArtifactRepository(api.store).save({
      id: 'notes-artifact',
      botId: 'scout',
      messageId: 'reference-message',
      path: 'notes.md',
      name: 'notes.md',
      createdAt: new Date().toISOString(),
    });
    for (const href of [`mukai://artifact/${file.id}#L2`, 'notes.md', join(project, 'notes.md')]) {
      const response = await preview(href);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await response.text()).toBe('# Notes\nSecond line');
    }
    const image = await preview(`mukai://attachment/${attachment.id}`, true);
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(25);
    expect((await preview('../outside.txt')).status).toBe(400);
    expect((await preview('https://example.com/secret')).status).toBe(400);
    expect((await preview('missing.md')).status).toBe(404);
    expect(
      (await fetch(api.url + '/conversations/bot-scout/reference', { method: 'POST' })).status,
    ).toBe(401);
    expect((await preview('notes.md', true)).status).toBe(400);
  });
  it('rediscovers an attached image after compaction, reopens its pixels and copies its original bytes without a workspace folder', async () => {
    await configure(true);
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const png = await sharp({
      create: { width: 25, height: 15, channels: 3, background: '#0088cc' },
    })
      .png()
      .toBuffer();
    const attachment = (await upload('reference.png', png)).data;
    await chat('Keep this image for later.', randomUUID(), 'scout', [attachment.id]);
    expect(JSON.stringify(calls[0].messages)).toContain(attachment.id);
    // Model context no longer contains the original message or its pixels, but
    // the conversation and upload remain saved and discoverable by the tool.
    const through = Number(
      api.store.get('SELECT MAX(sequence) AS sequence FROM messages')!.sequence,
    );
    api.store.run(
      'INSERT INTO conversation_contexts VALUES(?,?,?,?)',
      'bot-scout',
      'scout',
      'The user previously supplied a reference image.',
      through,
    );
    calls = [];
    mode = 'attachment-tools';
    await chat('Find the reference image again and copy it to the requested destination.');
    const current = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
    expect(current.status, current.error || JSON.stringify(current.activity)).toBe('complete');
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[0].messages)).not.toContain('data:image/png;base64');
    expect(JSON.stringify(calls[2].messages)).toContain('data:image/png;base64');
    expect(readFileSync(join(project, 'copied.png'))).toEqual(png);
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
    expect(reply.status, reply.error || '').toBe('complete');
    expect(reply.activity).toMatchObject([
      { tool: 'conversations', action: 'search_artifacts', status: 'complete' },
      {
        tool: 'media',
        action: 'view_image',
        attachmentId: attachment.id,
        path: 'reference.png',
        status: 'complete',
      },
      { tool: 'file_operations', action: 'copy_attachment', status: 'complete' },
    ]);
    const preview = await fetch(api.url + '/conversations/bot-scout/activity-image', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: reply.id, activityId: reply.activity![1].id }),
    });
    expect(preview.status).toBe(200);
    expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width).toBe(25);
  });
  it('returns expected artifact guidance through the SDK without an error stack or false correction diagnostic', async () => {
    await configure(true);
    const png = await sharp({
      create: { width: 25, height: 15, channels: 3, background: '#0088cc' },
    })
      .png()
      .toBuffer();
    artifactFeedbackId = (await upload('reference.png', png)).data.id;
    mode = 'artifact-feedback';
    await chat('Inspect my image.', randomUUID(), 'scout', [artifactFeedbackId]);
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
    expect(reply.status, reply.error || '').toBe('complete');
    expect(reply.activity).toMatchObject([
      { tool: 'conversations', status: 'failed' },
      {
        tool: 'conversations',
        action: 'read_artifact',
        status: 'failed',
        summary: expect.stringContaining('media.view_image'),
      },
    ]);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('image_requires_view');
    const diagnostics = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(diagnostics).toContain('chat.tool_input_invalid');
    expect(diagnostics).toContain('chat.tool_feedback');
    expect(diagnostics).not.toContain('chat.tool_failed');
    expect(diagnostics).not.toContain('chat.tool_input_corrected');
  });
  it('lists image tools without a workspace folder and honors bot assignment', async () => {
    const tools = (await request<ToolInfo[]>('/tools?workspaceId=default')).data;
    expect(tools).toContainEqual(
      expect.objectContaining({
        id: 'media',
        available: true,
        actions: [
          'read_image',
          'view_image',
          'read_audio',
          'listen_audio',
          'read_video',
          'view_video',
        ],
      }),
    );
    await request('/tools/assignments?workspaceId=default', 'PUT', {
      botId: 'scout',
      toolId: 'image',
      enabled: false,
    });
    expect((await request('/tools/assignments?workspaceId=default')).data).toContainEqual({
      botId: 'scout',
      toolId: 'media',
      enabled: false,
    });
  });
  it('delivers an autonomous update in the SDK loop and follows up in its seeded conversation', async () => {
    await configure();
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'autonomous-update';
    await chat('Send an update when the result is verified');
    const inbox = api.notifications.list('default');
    expect(inbox.total).toBe(1);
    expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
    const thread = api.notifications.continue('default', inbox.items[0].id);
    const previousCalls = calls.length;
    mode = 'normal';
    await privateChat(thread.id, 'What did you verify?');
    const history = (await request<ChatMessage[]>(`/conversations/${thread.id}/messages`)).data;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ role: 'assistant', content: inbox.items[0].message });
    expect(history[1]).toMatchObject({ role: 'user', content: 'What did you verify?' });
    expect(history[2].status).toBe('complete');
    expect(JSON.stringify(calls[previousCalls].messages)).toContain(inbox.items[0].message);
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
        toolName: 'communicate',
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
            tool: 'communicate',
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

  it('delivers a denial reason through the API into the ask tool result and activity', async () => {
    await configure();
    mode = 'ask-approval';
    const result = chat('Ask permission to publish');
    const item = await pendingApproval('custom-call-1');
    for (const body of [
      { approved: true, reason: 'Not yet.' },
      { approved: false, reason: '   ' },
      { approved: false, reason: 'x'.repeat(16001) },
    ])
      expect((await request(`/approvals/${item.id}`, 'POST', body)).response.status).toBe(400);
    expect(
      (
        await request(`/approvals/${item.id}`, 'POST', {
          approved: false,
          reason: '  Let me review it first.  ',
        })
      ).response.status,
    ).toBe(200);
    await result;
    const toolMessages = calls.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessages[0].content))).toEqual({
      action: 'approval',
      approved: false,
      reason: 'Let me review it first.',
    });
    expect(
      (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity![0].summary,
    ).toContain('Reason: Let me review it first.');
  });

  it.each([false, true])(
    'keeps answered questions saved on recovery (configuration changed: %s)',
    async (changed) => {
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
      if (changed) api.store.run("UPDATE chat_jobs SET fingerprint='previous-app-version'");
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      await vi.waitFor(async () =>
        expect(
          (await request<ApprovalState>('/approvals')).data.pending.map((item) => item.id).sort(),
        ).toEqual(
          pending
            .filter((item) => item.id !== question.id)
            .map((item) => item.id)
            .sort(),
        ),
      );
      await vi.waitFor(async () =>
        expect(
          (await request(`/approvals/${permission.id}`, 'POST', { approved: false })).response
            .status,
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
    },
  );

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
    // This fixture counts tool messages; keep compaction out of the approval-only scenario.
    await configure(false, { contextWindowTokens: 65536 });
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

  it('denies custom tool registration with a reason without registering the module', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Registration approval', folder: project });
    writeFileSync(
      join(project, 'approval-echo.ts'),
      `export default {name:'approval_echo',description:'Echo',inputSchema:{type:'object'},execute:()=>({ok:true})};`,
    );
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    mode = 'approval-registration';
    const run = chat('Register my custom tool');
    const approval = await pendingApproval('custom-call-1');
    expect(approval.toolName).toBe('register_custom_tool');
    expect(
      (
        await request(`/approvals/${approval.id}`, 'POST', {
          approved: false,
          reason: '  Review the source first.  ',
        })
      ).response.status,
    ).toBe(200);
    await run;
    expect(api.store.all('SELECT * FROM capabilities')).toHaveLength(0);
    const toolMessage = calls.at(-1)!.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessage!.content))).toMatchObject({
      rejected: true,
      reason: 'Review the source first.',
      message: expect.stringContaining('The user denied this tool call.'),
    });
    expect(
      (await request<ChatMessage[]>('/bots/scout/messages')).data[1].activity?.[0].summary,
    ).toContain('Reason: Review the source first.');
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
          permissionMode: 'user_approval',
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

  it.each([
    { approved: true, change: 'instructions' },
    { approved: false, change: 'instructions' },
    { approved: true, change: 'schema' },
    { approved: true, change: 'unavailable' },
    { approved: true, change: 'while-waiting' },
  ])(
    'keeps a custom action reviewable across an update ($change, approved=$approved)',
    async ({ approved, change }) => {
      await configure();
      project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
      await request('/workspaces/default', 'PUT', { name: 'Update approvals', folder: project });
      writeFileSync(
        join(project, 'approval-echo.ts'),
        `export default {name:'approval_echo',description:'Echo',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:(args)=>args};`,
      );
      const registration = (
        await request<{ id: string }>('/capabilities', 'POST', {
          kind: 'tool',
          operation: 'register',
          modulePath: 'approval-echo.ts',
          permissionMode: 'user_approval',
          ownerBotId: 'scout',
        })
      ).data;
      mode = 'approval-custom';
      const result = chat('Use my custom tool');
      const pending = await pendingApproval('custom-call-1');
      if (change === 'schema') {
        writeFileSync(
          join(project, 'approval-echo.ts'),
          `export default {name:'approval_echo',description:'Echo a number',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value']},execute:(args)=>args};`,
        );
        expect(
          (
            await request('/capabilities', 'POST', {
              kind: 'tool',
              operation: 'update',
              id: registration.id,
            })
          ).response.status,
        ).toBe(200);
      }
      if (change === 'unavailable')
        await request('/tools/assignments?workspaceId=default', 'PUT', {
          botId: 'scout',
          toolId: 'custom:' + registration.id,
          enabled: false,
        });
      await api.shutdown();
      await result;
      // Simulate an update that changes system instructions/tool definitions.
      api.store.run("UPDATE chat_jobs SET fingerprint='previous-app-version'");
      await close(api.server);
      for (let restart = 0; restart < 2; restart++) {
        api = await startApiServer(0, {
          dataDir: dir,
          memoryExtractor: async () => ({ facts: [] }),
        });
        await vi.waitFor(async () => {
          expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([
            { ...pending, reviewNotice: approvalReviewNotice },
          ]);
          expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
            'streaming',
          );
        });
        expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(0);
        expect(calls.filter((call) => call.stream)).toHaveLength(1);
        if (restart === 0) {
          await api.shutdown();
          await close(api.server);
        }
      }
      if (change === 'while-waiting') {
        writeFileSync(
          join(project, 'approval-echo.ts'),
          `export default {name:'approval_echo',description:'Changed after review started',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:(args)=>args};`,
        );
        expect(
          (
            await request('/capabilities', 'POST', {
              kind: 'tool',
              operation: 'update',
              id: registration.id,
            })
          ).response.status,
        ).toBe(200);
      }
      await vi.waitFor(async () =>
        expect(
          (await request(`/approvals/${pending.id}`, 'POST', { approved })).response.status,
        ).toBe(200),
      );
      await vi.waitFor(async () =>
        expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
          'complete',
        ),
      );
      expect(api.store.all('SELECT * FROM capability_runs')).toHaveLength(
        approved && change === 'instructions' ? 1 : 0,
      );
      expect((await request<ApprovalState>('/approvals')).data.pending).toEqual([]);
      if (change === 'instructions')
        expect(JSON.stringify(calls.at(-1)!.messages)).toContain(approved ? 'approved' : 'denied');
    },
  );

  it.each([
    { savedState: 'complete', changed: false },
    { savedState: 'uncertain', changed: false },
    { savedState: 'complete', changed: true },
    { savedState: 'uncertain', changed: true },
  ])(
    'restores parallel approvals with a $savedState sibling result (configuration changed: $changed)',
    async ({ savedState, changed }) => {
      // Retain the whole saved parallel step; compaction is covered separately.
      await configure(false, { contextWindowTokens: 262144 });
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
        permissionMode: 'user_approval',
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
      if (changed) api.store.run("UPDATE chat_jobs SET fingerprint='previous-app-version'");
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
      await vi.waitFor(async () =>
        expect((await request<ApprovalState>('/approvals')).data.pending).toEqual(
          pending
            .slice(1)
            .map((item) => (changed ? { ...item, reviewNotice: approvalReviewNotice } : item)),
        ),
      );
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
    const provider = await configure(false, {
      contextWindowTokens: 32768,
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
      contextWindow: 32768,
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
    ).toMatchObject({ estimated: true, inputTokens: null, contextWindow: 32768 });
    const switched = await request('/providers/' + provider.id, 'PUT', {
      ...provider,
      defaultModel: 'different-model',
      models: [
        ...provider.models!,
        {
          id: 'different-model',
          name: 'Different model',
          contextWindowTokens: null,
          maxOutputTokens: 8192,
          supportsImages: false,
        },
      ],
    });
    expect(switched.response.status).toBe(200);
    expect(
      (await request<ProviderSettings[]>('/providers')).data[0].contextWindowTokens,
    ).toBeNull();
  });
  it('recovers a temporary stream failure automatically without another user request', async () => {
    await configure();
    mode = 'transient-stream';
    await chat('Continue through a temporary outage');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status, readFileSync(join(dir, 'logs', 'errors.log'), 'utf8')).toBe('complete');
    expect(reply.content).toContain('A real SDK response.');
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(readFileSync(join(dir, 'logs', 'errors.log'), 'utf8')).toContain('chat.provider_retry');
  });

  it('waits for a buffered tool call using the saved model time limits', async () => {
    const provider = await configure(false, {
      responseTimeoutSeconds: 5,
      responseIdleTimeoutSeconds: 3,
    });
    expect(provider.models?.[0]).toMatchObject({
      responseTimeoutSeconds: 5,
      responseIdleTimeoutSeconds: 3,
    });
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Buffered tool', folder: project });
    mode = 'buffered-tool';
    await chat('Write the file and finish.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status, reply.error || '').toBe('complete');
    expect(calls).toHaveLength(2);
    expect(readFileSync(join(project, 'once.txt'), 'utf8')).toBe('Saved once.');
  });

  it('continues after a watchdog timeout with partial commentary and unfinished tool input, without repeating saved writes', async () => {
    await configure(false, { responseTimeoutSeconds: 10, responseIdleTimeoutSeconds: 1 });
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Timeout recovery', folder: project });
    mode = 'watchdog-once';
    await chat('Write once, then finish the renderer.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status, reply.error || '').toBe('complete');
    expect(reply.content).toContain('Now completing the remaining renderer work.');
    expect(reply.content).toContain('Finished using the saved file.');
    expect(reply.activity?.map((item) => item.action)).toEqual(['write_file', 'read_file']);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[2].messages)).toContain('Saved once.');
    expect(JSON.stringify(calls[2].messages)).toContain(
      'Now completing the remaining renderer work.',
    );
    expect(JSON.stringify(calls[2].messages)).not.toContain('unfinished-write');
    expect(calls[2].tools?.length).toBeGreaterThan(0);
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs).toContain('chat.provider_timeout_recovery');
    expect(logs).toContain('MUKAI_PROVIDER_IDLE_TIMEOUT');
    expect(logs).toContain('chat.provider_timeout_recovered');
    expect(api.store.all('SELECT * FROM chat_jobs')).toHaveLength(0);
  }, 10000);

  it('bounds watchdog continuations and leaves the checkpoint available for manual Retry', async () => {
    await configure(false, { responseTimeoutSeconds: 10, responseIdleTimeoutSeconds: 1 });
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Timeout ceiling', folder: project });
    mode = 'watchdog-always';
    await chat('Write once, then finish.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status).toBe('failed');
    expect(reply.error).toContain('idle timeout');
    expect(reply.error).not.toContain('connection');
    expect(calls).toHaveLength(4);
    expect(reply.activity).toHaveLength(1);
    const checkpoint = api.store.get(
      'SELECT checkpoint_json FROM chat_jobs WHERE message_id=?',
      reply.id,
    )!;
    expect(JSON.parse(String(checkpoint.checkpoint_json)).providerTimeoutRecoveries).toBe(2);
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs.match(/"event":"chat.provider_timeout_recovery"/g)).toHaveLength(2);
    expect(logs).not.toContain('chat.provider_timeout_recovered');
  }, 10000);

  it('does not retry a watchdog timeout after an operation executed in that generation', async () => {
    await configure(false, { responseTimeoutSeconds: 10, responseIdleTimeoutSeconds: 1 });
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Executed tool', folder: project });
    // Exercise a provider that finishes its tool call but leaves the stream
    // open: its write can execute before the subsequent stream stall.
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'executed-write',
              toolName: 'file_operations',
              input: JSON.stringify({
                action: 'write_file',
                path: 'once.txt',
                content: 'Saved once.',
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
            abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
              once: true,
            });
          },
        }),
      }),
    });
    const resolve = ProviderService.prototype.resolve;
    vi.spyOn(ProviderService.prototype, 'resolve').mockImplementation(function (
      this: ProviderService,
      bot,
    ) {
      return { ...resolve.call(this, bot), model };
    });
    await chat('Write once, then finish.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status).toBe('failed');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(readFileSync(join(project, 'once.txt'), 'utf8')).toBe('Saved once.');
    expect(readFileSync(join(dir, 'logs', 'errors.log'), 'utf8')).not.toContain(
      'chat.provider_timeout_recovery',
    );
  });

  it('honors Stop during a buffered generation without starting a watchdog continuation', async () => {
    await configure(false, { responseTimeoutSeconds: 10, responseIdleTimeoutSeconds: 1 });
    mode = 'watchdog-stop';
    const running = chat('Work until stopped.');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await request('/bots/scout/stop', 'POST');
    await running;
    expect(calls).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('stopped');
  });

  it('retains the watchdog continuation budget and pending approval across restart', async () => {
    await configure(false, { responseTimeoutSeconds: 10, responseIdleTimeoutSeconds: 1 });
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Timeout restart', folder: project });
    mode = 'watchdog-approval';
    const running = chat('Prepare the draft and ask before publishing.');
    const approval = await pendingApproval('watchdog-tool-1');
    expect(calls).toHaveLength(3);
    const row = api.store.get('SELECT checkpoint_json FROM chat_jobs')!;
    expect(JSON.parse(String(row.checkpoint_json)).providerTimeoutRecoveries).toBe(1);
    await api.shutdown();
    await close(api.server);
    await running;
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    await vi.waitFor(async () =>
      expect((await request<ApprovalState>('/approvals')).data.pending[0]?.id).toBe(approval.id),
    );
    expect((await request<ProviderSettings[]>('/providers')).data[0].models?.[0]).toMatchObject({
      responseTimeoutSeconds: 10,
      responseIdleTimeoutSeconds: 1,
    });
    expect(calls).toHaveLength(3);
    await request(`/approvals/${approval.id}`, 'POST', { approved: false });
    await vi.waitFor(
      async () =>
        expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe(
          'failed',
        ),
      { timeout: 5000 },
    );
    expect(calls).toHaveLength(5);
    const toolResults = calls.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(JSON.parse(String(toolResults.at(-1)!.content))).toEqual({
      action: 'approval',
      approved: false,
    });
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs.match(/"event":"chat.provider_timeout_recovery"/g)).toHaveLength(2);
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
  }, 10000);

  it.each(['malformed-stream', 'incomplete-stream', 'malformed-http'] as const)(
    'explains %s to the model and continues even after visible commentary',
    async (failureMode) => {
      await configure();
      mode = failureMode;
      await chat('Fix the pending/tickets mismatch.');
      const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      expect(reply.status, reply.error || '').toBe('complete');
      if (failureMode !== 'malformed-http') expect(reply.content).toContain('I found the defect');
      expect(reply.content).toContain('A real SDK response.');
      expect(calls).toHaveLength(2);
      const next = JSON.stringify(calls[1].messages);
      expect(next).toContain(
        failureMode === 'incomplete-stream' ? 'incomplete_tool_call' : 'invalid_tool_call',
      );
      expect(next).toContain('declared argument schema');
      expect(next).toContain('Do not repeat completed calls');
      if (failureMode !== 'malformed-http') expect(next).toContain('I found the defect');
      expect(next).not.toContain('PRIVATE_PROVIDER_PAYLOAD');
      const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
      expect(logs).toContain('chat.tool_call_recovery');
      expect(logs).toContain('chat.tool_call_recovered');
      expect(logs).not.toContain('chat.failed');
    },
  );

  it.each(['malformed-stream-with-tool', 'malformed-stream-after-tool'] as const)(
    'preserves successful tool results in %s without repeating the write',
    async (failureMode) => {
      await configure();
      project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
      await request('/workspaces/default', 'PUT', { name: 'Tool recovery', folder: project });
      mode = failureMode;
      await chat('Write once, then finish.');
      const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
      expect(reply.status, readFileSync(join(dir, 'logs', 'errors.log'), 'utf8')).toBe('complete');
      expect(readFileSync(join(project, 'once.txt'), 'utf8')).toBe('Written once.');
      expect(reply.activity?.filter((item) => item.id === 'write-once')).toMatchObject([
        { status: 'complete' },
      ]);
      expect(reply.changes).toHaveLength(1);
      const next = calls.at(-1)!.messages;
      expect(next.filter((message) => message.role === 'tool')).toHaveLength(
        failureMode === 'malformed-stream-with-tool' ? 2 : 1,
      );
      expect(JSON.stringify(next)).toContain('Written once.');
      expect(JSON.stringify(next)).toContain('invalid_tool_call');
      expect(calls).toHaveLength(3);
      if (failureMode === 'malformed-stream-with-tool')
        expect(JSON.stringify(calls[1].messages)).toContain('failed before Mukai dispatched it');
      expect(api.store.all('SELECT * FROM chat_jobs')).toHaveLength(0);
    },
  );

  it('bounds malformed-call repair and checkpoints the formatting feedback for manual Retry', async () => {
    await configure();
    mode = 'malformed-stream-always';
    await chat('Recover from malformed calls.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(3);
    expect(reply.status).toBe('failed');
    expect(reply.error).toContain('two correction attempts');
    expect(reply.error).not.toMatch(/credentials|balance/);
    const row = api.store.get('SELECT * FROM chat_jobs WHERE message_id=?', reply.id)!;
    expect(row.in_flight).toBe(0);
    const checkpoint = JSON.parse(String(row.checkpoint_json));
    expect(checkpoint.providerToolCallRecoveries).toBe(2);
    expect(JSON.stringify(checkpoint.messages)).toContain('invalid_tool_call');
    expect(JSON.stringify(checkpoint.messages)).not.toContain('PRIVATE_PROVIDER_PAYLOAD');
  });

  it('honors Stop while a malformed-call error is arriving and does not start a correction request', async () => {
    await configure();
    mode = 'malformed-stream-stop';
    const running = chat('Stop this response.');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await request('/bots/scout/stop', 'POST');
    await running;
    expect(calls).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('stopped');
  });

  it('continues an echoed announcement with tools available and preserves completed operations', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Echo recovery', folder: project });
    mode = 'reasoning-echo-once';
    await chat('Write once.txt, then check the saved contents.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status).toBe('complete');
    expect(reply.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: 'Finished the remaining check using saved progress.',
    });
    expect(reply.activity?.map((item) => item.action)).toEqual(['write_file', 'read_file']);
    expect(readFileSync(join(project, 'once.txt'), 'utf8')).toBe('Saved once.');
    expect(calls).toHaveLength(4);
    expect(calls[2].tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls[2].messages)).toContain(
      'Your previous response repeated your reasoning',
    );
    expect(JSON.stringify(calls[2].messages)).toContain('Saved once.');
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs.match(/"event":"chat.reasoning_echo_recovery"/g)).toHaveLength(1);
    expect(logs).toContain('chat.reasoning_echo_recovered');
    expect(api.store.all('SELECT * FROM chat_jobs')).toHaveLength(0);
  });

  it('bounds repeated reasoning echoes and saves progress for manual Retry', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Echo recovery', folder: project });
    mode = 'reasoning-echo-always';
    const sent = await chat('Write once.txt and finish the work.');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status).toBe('failed');
    expect(reply.error).toContain('after two recovery attempts');
    expect(reply.activity).toHaveLength(1);
    expect(calls).toHaveLength(4);
    const row = api.store.get('SELECT * FROM chat_jobs WHERE message_id=?', reply.id)!;
    expect(JSON.parse(String(row.checkpoint_json)).reasoningEchoRecoveries).toBe(2);
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs.match(/"event":"chat.reasoning_echo_recovery"/g)).toHaveLength(2);
    expect(logs).toContain('chat.reasoning_echo_failed');
    expect(logs).not.toContain('chat.reasoning_echo_recovered');
    mode = 'normal';
    await chat('', sent.requestId);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('complete');
    expect(readFileSync(join(project, 'once.txt'), 'utf8')).toBe('Saved once.');
  });

  it('honors Stop while an echoed final reply is arriving', async () => {
    await configure();
    mode = 'reasoning-echo-stop';
    const running = chat('Work until stopped.');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await request('/bots/scout/stop', 'POST');
    await running;
    expect(calls).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('stopped');
  });

  it('accepts a legitimate identical short answer without a recovery request', async () => {
    await configure();
    mode = 'reasoning-echo-answer';
    await chat('What is six times seven?');
    expect(calls).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1]).toMatchObject({
      status: 'complete',
      content: '42',
    });
  });

  it('compares only reasoning from the current generation, leaving earlier tool steps alone', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Earlier reasoning', folder: project });
    mode = 'reasoning-echo-stale';
    await chat('Write once.txt, then reply Continue.');
    expect(calls).toHaveLength(2);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('complete');
  });

  it('preserves the echo recovery budget and pending approval across restart', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Echo recovery', folder: project });
    mode = 'reasoning-echo-approval';
    const running = chat('Prepare the draft and ask before publishing.');
    const approval = await pendingApproval('echo-tool-1');
    expect(calls).toHaveLength(3);
    const row = api.store.get('SELECT * FROM chat_jobs')!;
    expect(JSON.parse(String(row.checkpoint_json)).reasoningEchoRecoveries).toBe(1);
    await api.shutdown();
    await close(api.server);
    await running;
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    await vi.waitFor(async () => {
      expect((await request<ApprovalState>('/approvals')).data.pending[0]?.id).toBe(approval.id);
    });
    expect(calls).toHaveLength(3);
    await request(`/approvals/${approval.id}`, 'POST', { approved: false });
    await vi.waitFor(async () => {
      expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('failed');
    });
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.error).toContain('after two recovery attempts');
    expect(reply.activity?.filter((item) => item.action === 'write_file')).toHaveLength(1);
    const approvalResult = calls
      .at(-1)!
      .messages.filter((message) => message.role === 'tool')
      .at(-1)!;
    expect(JSON.parse(String(approvalResult.content))).toEqual({
      action: 'approval',
      approved: false,
    });
    const logs = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
    expect(logs.match(/"event":"chat.reasoning_echo_recovery"/g)).toHaveLength(2);
    expect((await request<ApprovalState>('/approvals')).data.pending).toHaveLength(0);
  });

  it('returns a failed memory save to the model and still finishes the chat', async () => {
    await configure();
    mode = 'memory-failure';
    vi.spyOn(api.memory, 'add').mockRejectedValue(
      new DOMException('Memory request timed out', 'TimeoutError'),
    );
    await chat('Remember my coffee preference');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(reply.status).toBe('complete');
    expect(reply.error).toBeNull();
    expect(reply.activity).toContainEqual(
      expect.objectContaining({ tool: 'memory', status: 'failed' }),
    );
    expect(JSON.stringify(calls[1].messages)).toContain('Memory request timed out');
    expect(reply.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: 'A real SDK response.',
    });
  });
  it('bounds stream recovery and saves a final status when the provider remains unavailable', async () => {
    await configure();
    mode = 'transient-stream-always';
    await chat('Recover from an outage');
    const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(calls).toHaveLength(3);
    expect(reply.status).toBe('failed');
    expect(reply.content).toContain('Saved progress:');
    expect(reply.parts?.at(-1)).toMatchObject({ type: 'text', final: true });
  });

  it('honors Stop during retry backoff without starting another provider request', async () => {
    await configure();
    mode = 'transient-stream';
    const running = chat('Recover from an outage');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await request('/bots/scout/stop', 'POST');
    await running;
    expect(calls).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].status).toBe('stopped');
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
    await configure(false, {
      contextWindowTokens: 32768,
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
  it.each([false, true])(
    'does not announce compaction or advance saved history when only the response allowance shrinks (existing notebook: %s)',
    async (existingNotebook) => {
      await configure(false, { contextWindowTokens: 65536, maxOutputTokens: 32768 });
      await chat('Original finding');
      if (existingNotebook) {
        const through = Number(
          api.store.get('SELECT MAX(sequence) AS sequence FROM messages')!.sequence,
        );
        api.store.run(
          'INSERT INTO conversation_contexts VALUES(?,?,?,?)',
          'bot-scout',
          'scout',
          'Preserve the original notebook.',
          through,
        );
      }
      const saved = api.store.get(
        'SELECT * FROM conversation_contexts WHERE conversation_id=?',
        'bot-scout',
      );
      // Above the preferred input budget, but below the hard input limit.
      const evidence = 'Exact findings must survive. '.repeat(1000);
      await chat('Recent finding');
      const recent = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
      api.store.run(
        "UPDATE messages SET content=?,parts_json='[]' WHERE id=?",
        evidence,
        recent.id,
      );
      const sent = await chat('Review the findings.');
      const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
      const reply = history.at(-1)!;
      expect(reply.status).toBe('complete');
      expect(reply.contextUsage?.usedTokens).toBeGreaterThan(65536 * 0.9 - 32768);
      expect(reply.contextUsage?.compactions).toBe(0);
      expect(reply.parts?.some((part) => part.type === 'compaction')).toBe(false);
      expect(
        sent.events.some((event) => event.type === 'part' && event.part.type === 'compaction'),
      ).toBe(false);
      expect(
        sent.events.some((event) => event.type === 'context' && event.usage.phase === 'compacting'),
      ).toBe(false);
      expect(calls.filter((call) => !call.stream)).toHaveLength(0);
      expect(
        api.store.get('SELECT * FROM conversation_contexts WHERE conversation_id=?', 'bot-scout'),
      ).toEqual(saved);
      await chat('Continue from the exact findings.');
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain(evidence);
      if (existingNotebook)
        expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Preserve the original notebook.');
    },
  );
  it('recovers saved history behind an empty notebook from an older context check', async () => {
    await configure();
    await chat('Original evidence must remain available.');
    const through = Number(
      api.store.get('SELECT MAX(sequence) AS sequence FROM messages')!.sequence,
    );
    api.store.run(
      'INSERT INTO conversation_contexts VALUES(?,?,?,?)',
      'bot-scout',
      'scout',
      '',
      through,
    );
    await chat('Continue');
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain(
      'Original evidence must remain available.',
    );
  });
  it('compacts old history without altering saved messages and reuses its notebook next turn', async () => {
    await configure(false, {
      contextWindowTokens: 32768,
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
      await configure(false, {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
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
  it.each(['compaction-fail', 'compaction-invalid', 'compaction-filter'] as const)(
    'continues with saved-source excerpts after %s and reuses the notebook after restart',
    async (failure) => {
      await configure(false, { contextWindowTokens: 32768, maxOutputTokens: 1024 });
      await chat('Earlier finding');
      const first = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
      const evidence = 'Keep original evidence. '.repeat(3000);
      api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, first.id);
      mode = failure;
      await chat('Continue exactly from these findings');
      let history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
      expect(history.at(-1)?.status).toBe('complete');
      expect(history.at(-1)?.error).toBeFalsy();
      expect(history.at(-1)?.parts?.find((part) => part.type === 'compaction')).toMatchObject({
        state: 'complete',
      });
      expect(calls.filter((call) => !call.stream)).toHaveLength(
        failure === 'compaction-filter' ? 1 : 3,
      );
      const saved = api.store.get(
        'SELECT summary FROM conversation_contexts WHERE conversation_id=?',
        'bot-scout',
      )!;
      expect(String(saved.summary)).toContain('Keep original evidence.');
      expect(String(saved.summary)).not.toContain('Invented summary');
      expect(history[0].content).toBe(evidence);
      const diagnostics = readFileSync(join(dir, 'logs', 'errors.log'), 'utf8');
      expect(diagnostics).toContain('chat.compaction_recovered');
      expect(diagnostics).not.toContain('Unobserved result');
      await api.shutdown();
      await close(api.server);
      api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
      mode = 'normal';
      await chat('Now follow up');
      history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
      expect(history).toHaveLength(6);
      expect(history.at(-1)?.status).toBe('complete');
      expect(history[0].content).toBe(evidence);
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Keep original evidence.');
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain(
        'retrieve saved history before repeating',
      );
    },
  );
  it('honors Stop during compaction and leaves the original history intact', async () => {
    await configure(false, { contextWindowTokens: 32768, maxOutputTokens: 1024 });
    await chat('Earlier finding');
    const first = (await request<ChatMessage[]>('/bots/scout/messages')).data[0];
    const evidence = 'Original evidence. '.repeat(3000);
    api.store.run('UPDATE messages SET content=? WHERE id=?', evidence, first.id);
    mode = 'compaction-slow';
    const running = chat('Continue safely');
    await vi.waitFor(() => expect(calls.some((call) => !call.stream)).toBe(true));
    const live = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
    expect(live.parts?.at(-1)).toMatchObject({ type: 'compaction', state: 'compacting' });
    await request('/bots/scout/stop', 'POST');
    await running;
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].content).toBe(evidence);
    expect(api.store.all('SELECT * FROM conversation_contexts')).toEqual([]);
    expect(calls.filter((call) => !call.stream)).toHaveLength(1);
    expect(history.at(-1)?.parts?.find((part) => part.type === 'compaction')).toMatchObject({
      state: 'interrupted',
    });
    expect(history.at(-1)?.status).toBe('stopped');
  });
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
      const savedMessages = structuredClone(calls.at(-1)!.messages);
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
      expect(calls.at(-1)!.messages.slice(0, savedMessages.length)).toEqual(savedMessages);
      expect(String(calls.at(-1)!.messages.at(-1)?.content)).toContain('Runtime notice: Resume');
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
  it('recovers invalid compaction while resuming a checkpoint without repeating its completed file write', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'Recovery', folder: project })
    ).data;
    const bot = (await request<Bot>('/bots', 'POST', { ...inputBot(), workspaceId: workspace.id }))
      .data;
    mode = 'checkpoint';
    const sent = await chat('Write once, then report.', randomUUID(), bot.id);
    const first = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1];
    expect(first.status).toBe('failed');
    expect(first.activity).toHaveLength(1);
    expect(readFileSync(join(project, 'checkpoint.txt'), 'utf8')).toBe('Saved once.');
    // Give forced compaction actual history to summarize. Expired runtime
    // snapshots alone can be removed without invoking the summarizer.
    const row = api.store.get(
      'SELECT checkpoint_json FROM chat_jobs WHERE message_id=?',
      first.id,
    )!;
    const checkpoint = JSON.parse(String(row.checkpoint_json));
    checkpoint.messages.unshift({
      role: 'assistant',
      content: 'Earlier observation saved before the write.',
    });
    api.store.run(
      'UPDATE chat_jobs SET checkpoint_json=? WHERE message_id=?',
      JSON.stringify(checkpoint),
      first.id,
    );
    // A second write would overwrite this edit, exposing a replay even if IDs were reused.
    writeFileSync(join(project, 'checkpoint.txt'), 'User edited after completed operation.');
    await api.shutdown();
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
    mode = 'compaction-overflow';
    await chat('ignored replacement', sent.requestId, bot.id);
    const history = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data;
    expect(history).toHaveLength(2);
    expect(history[1].status).toBe('complete');
    expect(history[1].activity).toEqual(first.activity);
    expect(history[1].parts?.find((part) => part.type === 'compaction')).toMatchObject({
      state: 'complete',
    });
    expect(calls.filter((call) => !call.stream)).toHaveLength(3);
    expect(readFileSync(join(project, 'checkpoint.txt'), 'utf8')).toBe(
      'User edited after completed operation.',
    );
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('checkpoint.txt');
    expect(JSON.stringify(calls.at(-1)?.messages)).not.toContain('Invented summary');
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain('Runtime notice: Resume');
    expect(api.store.all('SELECT * FROM chat_jobs')).toEqual([]);
  });
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
    await configure(false, {
      contextWindowTokens: 28000,
      maxOutputTokens: 1024,
    });
    await chat('Short request fits');
    const fits = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(fits.status, fits.error || undefined).toBe('complete');
    expect(calls).toHaveLength(1);
    const text = 'Exact input '.repeat(1300);
    await chat(text);
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[2].content).toBe(text.trim());
    expect(history[3].status).toBe('failed');
    expect(history[3].error).toContain('current request');
    expect(calls).toHaveLength(1);
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
    expect(calls.at(-1)!.messages).toHaveLength(12);
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
    const steps = calls.filter((call) => call.stream);
    expect(steps).toHaveLength(10);
    expect(JSON.stringify(steps.slice(5, 9))).toContain('Reassess the approach');
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
  it('keeps a safety pause authoritative even when its final report echoes reasoning', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    await request('/workspaces/default', 'PUT', { name: 'Safety pause', folder: project });
    mode = 'tool-limit-echo';
    await chat('Keep checking until the runtime pauses.');
    const message = (await request<ChatMessage[]>('/bots/scout/messages')).data[1];
    expect(message.status).toBe('interrupted');
    expect(message.error).toContain('without progress');
    expect(calls.filter((call) => call.stream)).toHaveLength(10);
    expect(calls.at(-1)).not.toHaveProperty('tools');
  });

  it('continues browser work past the previous eight-step ceiling', async () => {
    // Keep all twelve mock results in context: the protocol fixture counts them
    // to decide its next step and cannot recover that count from a mock summary.
    await configure(false, { contextWindowTokens: 262144 });
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
  }, 20000);
  // The default instructions, tool schemas, and skill catalog need about 25K
  // tokens before results. Use 30K/32K windows so the fixture tests result
  // bounding rather than an undersized mandatory context. The multi-megabyte
  // results and 16000x16000 screenshot still exceed both windows.
  it.each([30000, 32768])(
    'finishes with huge parallel results and an oversized screenshot at %i context',
    async (contextWindowTokens) => {
      await configure(true, {
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
    for (let index = 1; index < calls.length; index++) {
      const previous = calls[index - 1].messages;
      const current = calls[index].messages;
      expect(current.slice(0, previous.length)).toEqual(previous);
      expect(current.at(-2)?.role).toBe('tool');
      expect(String(current.at(-1)?.content)).toContain('Runtime UTC now: ');
      expect(String(current[0].content)).not.toMatch(/Current UTC time:|Runtime UTC now:/);
    }
    expect(sent.events.some((event) => event.type === 'reasoning')).toBe(true);
    expect(sent.events.filter((event) => event.type === 'activity')).toHaveLength(10);
    expect(sent.events).toContainEqual(
      expect.objectContaining({
        type: 'activity',
        activity: expect.objectContaining({ action: 'write_file', status: 'complete' }),
        changes: [expect.objectContaining({ path: 'draft.md', kind: 'created' })],
      }),
    );
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
    unlinkSync(join(project, 'draft.md'));
    const missingFile = await request<{ error: string }>('/artifacts/' + artifacts[0].id);
    expect(missingFile.response.status).toBe(404);
    expect(missingFile.data.error).toContain('no longer available in the workspace folder');
    writeFileSync(join(project, 'draft.md'), detail.after);
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
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'null'])(
    'allows conditional desktop polls from %s and returns changed permissions',
    async (origin) => {
      const path = api.url + '/approvals?workspaceId=default';
      const preflight = await fetch(path, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,if-none-match',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      const allowed = preflight.headers.get('Access-Control-Allow-Headers')!.toLowerCase();
      expect(allowed.split(',').map((header) => header.trim())).toEqual(
        expect.arrayContaining(['authorization', 'if-none-match']),
      );
      const headers = { Origin: origin, Authorization: `Bearer ${api.token}` };
      const first = await fetch(path, { headers });
      expect(first.status).toBe(200);
      const initial = (await first.json()) as ApprovalState;
      const etag = first.headers.get('ETag')!;
      expect(etag).toBeTruthy();
      expect(first.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
      const conditional = { ...headers, 'If-None-Match': etag };
      for (let poll = 0; poll < 3; poll++) {
        const response = await fetch(path, { headers: conditional });
        expect(response.status).toBe(304);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
        expect(await response.text()).toBe('');
      }
      const mode = initial.mode === 'full-access' ? 'ask-for-approval' : 'full-access';
      expect(
        (await request('/approvals?workspaceId=default', 'PUT', { mode })).response.status,
      ).toBe(200);
      const changed = await fetch(path, { headers: conditional });
      expect(changed.status).toBe(200);
      expect(changed.headers.get('ETag')).not.toBe(etag);
      expect(await changed.json()).toMatchObject({ mode });
    },
  );
  it('rejects conditional polling preflights from untrusted pages', async () => {
    const response = await fetch(api.url + '/approvals?workspaceId=default', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5273',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,if-none-match',
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
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
      content: expect.stringContaining(mukaiEnvironmentInstructions),
    });
    const writerSystem = String(calls[1].messages[0].content);
    expect(writerSystem).toContain(mukaiEnvironmentInstructions);
    expect(writerSystem).toContain(
      JSON.stringify({
        id: bot.id,
        name: 'Writer',
        role: 'Writer',
        isMain: false,
        createdBy: 'scout',
      }),
    );
    expect(writerSystem).toContain('Write in short sentences.');
    expect(writerSystem).not.toMatch(/Current UTC time:|Runtime UTC now:/);
    expect(String(calls[1].messages.at(-1)?.content)).toContain('Runtime UTC now: ');
    expect(writerSystem).toContain('You are a workspace sub-bot.');
    expect(writerSystem).not.toContain("You are the workspace's main bot");
    expect(String(calls[0].messages[0].content)).toContain("You are the workspace's main bot");
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
    expect(latest.messages).toHaveLength(15); // System, thirteen chat messages, runtime context.
    expect(latest.messages.at(-2)).toEqual({ role: 'user', content: 'Prompt 6' });
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
  it('sends audio and video through the SDK and replaces unsupported history after model switches', async () => {
    const provider = await configure(false, {
      supportsAudio: true,
      supportsVideo: true,
      contextWindowTokens: 262144,
    });
    const audio = await upload('recording.wav', wavFixture());
    const video = await upload('clip.mp4', mp4Fixture());
    expect(audio.response.status).toBe(201);
    expect(video.response.status).toBe(201);
    expect(audio.data.kind).toBe('audio');
    expect(video.data.kind).toBe('video');
    const sent = await chat('Compare the recording and clip', randomUUID(), 'scout', [
      audio.data.id,
      video.data.id,
    ]);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('input_audio');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('video_url');
    const first = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
    expect(first.status, first.error || '').toBe('complete');
    const change = async (enabled: boolean) => {
      const models = provider.models!.map((model) => ({
        ...model,
        supportsAudio: enabled,
        supportsVideo: enabled,
      }));
      expect(
        (
          await request(`/providers/${provider.id}/models`, 'PUT', {
            models,
            defaultModel: provider.defaultModel,
          })
        ).response.status,
      ).toBe(200);
    };
    await change(false);
    await chat('Continue with this text-only model');
    const textOnly = JSON.stringify(calls.at(-1)!.messages);
    expect(textOnly).toContain('does not support audio input');
    expect(textOnly).toContain('does not support video input');
    expect(textOnly).not.toContain('input_audio');
    expect(textOnly).not.toContain('video_url');
    expect(textOnly).not.toContain(wavFixture().toString('base64'));
    await change(true);
    await chat('Inspect those attachments again');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('input_audio');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('video_url');
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].attachments.map((file) => file.kind)).toEqual(['audio', 'video']);
    expect(history.every((message) => message.status === 'complete')).toBe(true);
    expect(sent.events.at(-1)?.type).toBe('done');
  });
  it.each([false, true])(
    'inspects local media through tools and handles provider rejection=%s without repeating calls',
    async (rejected) => {
      await configure(false, {
        supportsAudio: true,
        supportsVideo: true,
        contextWindowTokens: 262144,
      });
      writeFileSync(join(dir, 'outside.wav'), wavFixture());
      writeFileSync(join(dir, 'outside.mp4'), mp4Fixture());
      mode = rejected ? 'media-tools-rejected' : 'media-tools';
      await chat('Inspect the existing audio and video files');
      const reply = (await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)!;
      expect(reply).toMatchObject({
        status: 'complete',
        error: null,
        content: 'Media inspection finished.',
      });
      expect(calls).toHaveLength(rejected ? 3 : 2);
      expect(JSON.stringify(calls[0].messages)).not.toMatch(/input_audio|video_url/);
      expect(JSON.stringify(calls[1].messages)).toContain('input_audio');
      expect(JSON.stringify(calls[1].messages)).toContain('video_url');
      expect(reply.activity).toHaveLength(2);
      for (const activity of reply.activity!) {
        expect(activity).toMatchObject({ tool: 'media', status: 'complete' });
        expect(JSON.parse(activity.summary.split('\n\n')[0])).toMatchObject({
          mediaIncluded: !rejected,
          mediaDelivery: rejected ? 'omitted' : 'included',
        });
        expect(activity.summary).not.toContain(wavFixture().toString('base64'));
      }
      if (rejected) {
        const fallback = JSON.stringify(calls[2].messages);
        expect(fallback).toContain('Mukai media notice');
        expect(fallback).not.toMatch(
          /input_audio|video_url|tell the user|private-test-key|Explain the limitation/i,
        );
      }
    },
  );
  it('retries a failed audio response safely after switching to a text-only model', async () => {
    const provider = await configure(false, { supportsAudio: true, contextWindowTokens: 262144 });
    const audio = await upload('recording.wav', wavFixture());
    mode = 'fail';
    const sent = await chat('Listen to this recording', randomUUID(), 'scout', [audio.data.id]);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data.at(-1)?.status).toBe(
      'failed',
    );
    expect(calls).toHaveLength(1); // A credential failure must never trigger a media retry.
    await request(`/providers/${provider.id}/models`, 'PUT', {
      models: provider.models!.map((model) => ({ ...model, supportsAudio: false })),
      defaultModel: provider.defaultModel,
    });
    mode = 'normal';
    await chat('ignored replacement', sent.requestId);
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.status).toBe('complete');
    expect(history[0].attachments[0].id).toBe(audio.data.id);
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('does not support audio input');
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('input_audio');
  });
  it('replaces provider-rejected media with model context and completes without a user error', async () => {
    await configure(false, {
      supportsAudio: true,
      supportsVideo: true,
      contextWindowTokens: 262144,
    });
    const audio = await upload('recording.wav', wavFixture());
    const video = await upload('clip.mp4', mp4Fixture());
    mode = 'media-rejected';
    const sent = await chat('Inspect these recordings', randomUUID(), 'scout', [
      audio.data.id,
      video.data.id,
    ]);
    expect(calls).toHaveLength(2);
    const retried = JSON.stringify(calls[1].messages);
    expect(retried).toContain('Mukai media notice');
    expect(retried).not.toMatch(/tell the user|explain the limitation|do not claim/i);
    expect(retried).not.toMatch(/input_audio|video_url|private-test-key/);
    expect(retried).not.toContain(wavFixture().toString('base64'));
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].attachments.map((file) => file.id)).toEqual([audio.data.id, video.data.id]);
    expect(history[1]).toMatchObject({ status: 'complete', error: null });
    expect(sent.events.some((event) => event.type === 'error')).toBe(false);
    // A later request can still deliver the retained original bytes.
    mode = 'normal';
    await chat('Inspect them again');
    expect(JSON.stringify(calls.at(-1)!.messages)).toContain('input_audio');
  });
  it('turns media that exceeds the current input budget into context instead of failing the response', async () => {
    await configure(false, {
      supportsAudio: true,
      contextWindowTokens: 40000,
      maxOutputTokens: 4096,
    });
    const ids: string[] = [];
    for (let index = 0; index < 4; index++)
      ids.push((await upload(`recording-${index}.wav`, wavFixture())).data.id);
    await chat('Summarize these recordings', randomUUID(), 'scout', ids);
    expect(calls).toHaveLength(1);
    const context = JSON.stringify(calls[0].messages);
    expect(context).toContain('current model input budget could not fit');
    expect(context).not.toContain('input_audio');
    const history = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(history[0].attachments).toHaveLength(4);
    expect(history[1]).toMatchObject({ status: 'complete', error: null });
  });
  it('rejects unsupported pending media, invalid recordings and audio-only MP4 without consuming uploads', async () => {
    await configure(false);
    expect((await upload('fake.wav', Buffer.from('not audio'))).response.status).toBe(400);
    expect((await upload('fake.mp4', mp4Fixture('soun'))).response.status).toBe(400);
    const audio = await upload('recording.wav', wavFixture());
    const result = await request<{ error: string }>('/bots/scout/chat', 'POST', {
      requestId: randomUUID(),
      text: 'Listen',
      attachmentIds: [audio.data.id],
    });
    expect(result.response.status).toBe(400);
    expect(JSON.stringify(result.data)).toContain('does not support audio input');
    expect(calls).toHaveLength(0);
    expect((await request<Attachment[]>('/bots/scout/attachments')).data).toHaveLength(1);
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data).toHaveLength(0);
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
    const enabled = await request(`/providers/${provider.id}`, 'PUT', {
      ...provider,
      models: provider.models!.map((model) => ({ ...model, supportsImages: true })),
    });
    expect(enabled.response.status).toBe(200);
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

it('cancels an active response before deleting the workspace conversation records', async () => {
  await configure();
  mode = 'slow';
  const response = await fetch(api.url + '/bots/scout/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), text: 'Keep responding', attachmentIds: [] }),
  });
  expect(response.status).toBe(200);
  const completion = response.text();
  const workspace = api.workspaces.require('default');
  const deleted = await request('/workspaces/default', 'DELETE', { name: workspace.name });
  expect(deleted.response.status).toBe(200);
  expect(await completion).toContain('stopped');
  expect(api.store.all('SELECT * FROM conversations')).toEqual([]);
  expect(api.store.all('SELECT * FROM bots')).toEqual([]);
  expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
});

it('saves model configuration independently of the provider connection and rejects invalid model updates', async () => {
  const provider = await configure();
  const encryptedKey = api.store.get(
    'SELECT encrypted_key FROM providers WHERE id=?',
    provider.id,
  )?.encrypted_key;
  const models = [
    {
      id: 'new-default',
      name: 'New default',
      contextWindowTokens: 128000,
      maxOutputTokens: 32768,
      supportsImages: true,
    },
  ];
  const updated = await request<ProviderSettings>(`/providers/${provider.id}/models`, 'PUT', {
    models,
    defaultModel: 'new-default',
  });
  expect(updated.response.status).toBe(200);
  expect(updated.data).toMatchObject({
    name: provider.name,
    baseUrl: provider.baseUrl,
    hasKey: true,
    isDefault: true,
    models,
    defaultModel: 'new-default',
    contextWindowTokens: 128000,
    maxOutputTokens: 32768,
    supportsImages: true,
  });
  expect(
    api.store.get('SELECT encrypted_key FROM providers WHERE id=?', provider.id)?.encrypted_key,
  ).toBe(encryptedKey);
  for (const input of [
    { models, defaultModel: 'missing' },
    { models, defaultModel: '' },
    { models: [models[0], models[0]], defaultModel: 'new-default' },
    { models, defaultModel: 'new-default', apiKey: 'should-not-change' },
    { models: [{ ...models[0], responseTimeoutSeconds: 0 }], defaultModel: 'new-default' },
    { models: [{ ...models[0], responseIdleTimeoutSeconds: 7201 }], defaultModel: 'new-default' },
    { models: [{ ...models[0], responseTimeoutSeconds: 1.5 }], defaultModel: 'new-default' },
  ])
    expect((await request(`/providers/${provider.id}/models`, 'PUT', input)).response.status).toBe(
      400,
    );
  expect((await request<ProviderSettings[]>('/providers')).data[0].models).toEqual(models);
});
