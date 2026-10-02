import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { startApiServer } from './app';
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

// A test-only OpenAI protocol server exercises the actual SDK, HTTP streaming,
// persistence, and error handling without a cloud key or billable requests.
let fixture: Server, api: Awaited<ReturnType<typeof startApiServer>>, dir: string;
let calls: { model: string; messages: { role: string; content: unknown }[] }[];
let mode:
  'normal' | 'fail' | 'slow' | 'tools' | 'invalid-tool' | 'tool-limit' | 'no-final' | 'truncated' =
  'normal';
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
  dir = mkdtempSync(join(tmpdir(), 'mukai-test-'));
  calls = [];
  mode = 'normal';
  project = '';
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (mode === 'fail') {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'DO NOT EXPOSE private-test-key' } }));
      return;
    }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (['tools', 'invalid-tool', 'tool-limit', 'no-final'].includes(mode)) {
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
                    completed === 7 ? { action: 'invalid_action' } : { action: 'list', path: '.' },
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
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
  api = await startApiServer(0, { dataDir: dir });
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
    api = await startApiServer(0, { dataDir: dir });
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
  it('reserves a tool-free final response after eight steps, including a failed last tool call', async () => {
    await configure();
    project = mkdtempSync(join(tmpdir(), 'mukai-project-'));
    const workspace = (
      await request<Workspace>('/workspaces', 'POST', { name: 'Step limit', folder: project })
    ).data;
    const bot = (await request<Bot[]>(`/bots?workspaceId=${workspace.id}`)).data[0];
    mode = 'tool-limit';
    const sent = await chat('Work until the limit', randomUUID(), bot.id);
    expect(calls).toHaveLength(9);
    expect(calls.at(-1)).not.toHaveProperty('tools');
    expect(JSON.stringify(calls.at(-1))).toContain('Give your final response now');
    const message = (await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data[1];
    expect(message.status).toBe('complete');
    expect(message.parts?.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Final report:'),
    });
    expect(message.activity?.at(-1)?.status).toBe('failed');
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
    const bot = (await request<Bot[]>(`/bots?workspaceId=${workspace.id}`)).data[0];
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
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('Scout');
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
    api = await startApiServer(0, { dataDir: dir });
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
    const bot = (await request<Bot[]>(`/bots?workspaceId=${workspace.id}`)).data[0];
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
      scope: 'all-bots',
      available: true,
      counts: { write_file: 1, patch: 1 },
    });
    await close(api.server);
    api = await startApiServer(0, { dataDir: dir });
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
  it('creates Scout once, persists independent chats, and honors each bot’s instructions and model', async () => {
    const provider = await configure();
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.name)).toEqual(['Scout']);
    const bot = (
      await request<Bot>('/bots', 'POST', {
        name: 'Writer',
        description: 'Clear writing',
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
      content: expect.stringMatching(/^Write in short sentences\.\nCurrent UTC time: /),
    });
    expect((await request<ChatMessage[]>(`/bots/${bot.id}/messages`)).data).toHaveLength(2);
    await api.shutdown();
    await close(api.server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    api = await startApiServer(0, { dataDir: dir });
    expect((await request<ChatMessage[]>('/bots/scout/messages')).data[1].content).toBe(
      'A real SDK response.',
    );
    expect((await request<Bot[]>('/bots')).data).toHaveLength(2);
    expect(api.store.all('SELECT version FROM schema_migrations')).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ]);
    await request('/bots/scout', 'DELETE');
    await api.shutdown();
    await close(api.server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    api = await startApiServer(0, { dataDir: dir });
    expect((await request<Bot[]>('/bots')).data.map((bot) => bot.name)).toEqual(['Writer']);
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
    api = await startApiServer(0, { dataDir: dir });
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
    expect(log).not.toHaveBeenCalled();
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
        description: '',
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
    api = await startApiServer(0, { dataDir: dir });
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
    await expect(startApiServer(0, { dataDir: dir })).rejects.toThrow('Another Mukai backend');
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
    const messages = (await request<ChatMessage[]>('/bots/scout/messages')).data;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Keep me');
    expect(messages[1].status).toBe('interrupted');
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
