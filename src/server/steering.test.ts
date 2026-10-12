import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { ConversationRepository } from './repositories/conversationRepository';
import { ChatFollowupRepository } from './repositories/chatFollowupRepository';
import type { ChatEvent, ChatMessage } from '../shared/ai';

type ProviderInput = {
  model: string;
  messages: {
    role: string;
    content: unknown;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
  }[];
};
let api: Awaited<ReturnType<typeof startApiServer>>, fixture: Server, dir: string;
let mode: 'hold' | 'normal' | 'tool' | 'fail' | 'overload-tools';
let seen: ProviderInput[];
let held: { response: ServerResponse; finish: () => void }[];
const waitFor = (check: () => unknown | Promise<unknown>) => vi.waitFor(check, { timeout: 5000 });
async function request(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(api.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() };
}
async function chat(text = 'Original task', requestId = randomUUID(), root = '/bots/scout') {
  const response = await fetch(api.url + root + '/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestId, attachmentIds: [] }),
  });
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatEvent);
}
async function queue(text: string, root = '/bots/scout') {
  const id = randomUUID();
  expect((await request(root + '/followups', 'POST', { id, text })).status).toBe(201);
  return id;
}
async function steer(id: string, expectedRequestId: string, root = '/bots/scout') {
  return request(root + '/followups', 'PUT', { action: 'steer', id, expectedRequestId });
}
async function history(root = '/bots/scout') {
  return (await request(root + '/messages')).data as ChatMessage[];
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-steering-'));
  seen = [];
  held = [];
  mode = 'hold';
  const overloadedSteps = new Set<number>();
  fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as ProviderInput;
    seen.push(input);
    if (mode === 'fail') {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'Fixture failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const completedTools = input.messages.filter((message) => message.role === 'tool').length;
    if (mode === 'overload-tools' && !overloadedSteps.has(completedTools)) {
      overloadedSteps.add(completedTools);
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
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    if (
      (mode === 'tool' && !input.messages.some((message) => message.role === 'tool')) ||
      (mode === 'overload-tools' && completedTools < 3)
    ) {
      send({
        tool_calls: [
          {
            index: 0,
            id: mode === 'overload-tools' ? 'retry-step-' + completedTools : 'slow-call',
            type: 'function',
            function: {
              name: 'browser',
              arguments: JSON.stringify({ action: 'snapshot', sessionId: randomUUID() }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    } else {
      send({ content: 'Partial progress. ' });
      const finish = () => {
        if (res.destroyed) return;
        send({ content: 'Completed with the latest guidance.' }, 'stop');
        res.end('data: [DONE]\n\n');
      };
      if (mode === 'hold') held.push({ response: res, finish });
      else finish();
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
  const endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
  expect(
    (
      await request('/providers', 'POST', {
        name: 'Fixture',
        kind: 'compatible',
        baseUrl: endpoint,
        defaultModel: 'test-chat',
        models: [
          {
            id: 'test-chat',
            name: 'Fixture',
            contextWindowTokens: 32768,
            maxOutputTokens: 4096,
            supportsImages: false,
          },
        ],
        supportsImages: false,
        isDefault: true,
      })
    ).status,
  ).toBe(201);
});
afterEach(async () => {
  for (const item of held) item.finish();
  await api.shutdown();
  await close(api.server);
  api.dispose();
  await close(fixture);
  vi.restoreAllMocks();
  if (!dir.startsWith(join(tmpdir(), 'mukai-steering-'))) throw new Error('Unexpected test folder');
  rmSync(dir, { recursive: true, force: true });
});

it('steers a compatible model during text generation, retaining partial progress and the same run', async () => {
  const requestId = randomUUID();
  const running = chat('Original task', requestId);
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Focus on mobile');
  expect(seen).toHaveLength(1);
  mode = 'normal';
  expect((await steer(id, requestId)).status).toBe(200);
  expect((await steer(id, requestId)).status).toBe(200);
  const events = await running;
  const done = events.at(-1)!;
  expect(done.type).toBe('done');
  if (done.type !== 'done') throw new Error('Expected completed response');
  expect(done.message.status).toBe('complete');
  expect(done.message.requestId).toBe(requestId);
  expect(done.message.parts).toContainEqual(
    expect.objectContaining({ id, type: 'steering', text: 'Focus on mobile' }),
  );
  const timestamp = api.store.get(
    'SELECT created_at FROM chat_followups WHERE id=?',
    id,
  )?.created_at;
  expect(done.message.parts?.find((part) => part.type === 'steering')?.createdAt).toBe(timestamp);
  expect(await history()).toHaveLength(2);
  expect(seen).toHaveLength(2);
  expect(
    seen[1].messages.filter(
      (message) => message.role === 'user' && message.content === 'Focus on mobile',
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(seen[1].messages)).toContain('Original task');
  expect(JSON.stringify(seen[1].messages)).toContain('Partial progress');
  expect((await request('/bots/scout/followups')).data).toEqual([]);
  expect(
    (await request('/bots/scout/followups', 'PUT', { action: 'edit', id, text: 'Too late' }))
      .status,
  ).toBe(409);
  await chat('Next task');
  expect(JSON.stringify(seen.at(-1)!.messages)).toContain('Focus on mobile');
  const nextHistory = seen.at(-1)!.messages;
  const correctionIndex = nextHistory.findIndex(
    (message) => message.role === 'user' && message.content === 'Focus on mobile',
  );
  const answerIndex = nextHistory.findIndex(
    (message) =>
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.includes('Completed with the latest guidance'),
  );
  expect(correctionIndex).toBeLessThan(answerIndex);
});

it('queues, edits, deletes and sends follow-ups once in order after completion', async () => {
  const running = chat();
  await waitFor(() => expect(held).toHaveLength(1));
  const first = await queue('First follow-up');
  const second = await queue('Second follow-up');
  const deleted = await queue('Do not send');
  expect(
    (
      await request('/bots/scout/followups', 'PUT', {
        action: 'edit',
        id: first,
        text: 'Edited first',
      })
    ).status,
  ).toBe(200);
  await request('/bots/scout/followups', 'PUT', { action: 'delete', id: deleted });
  expect(
    (await request('/bots/scout/followups', 'POST', { id: second, text: 'Second follow-up' }))
      .status,
  ).toBe(201);
  expect(seen).toHaveLength(1);
  mode = 'normal';
  held[0].finish();
  await running;
  await waitFor(async () =>
    expect(
      (await history()).filter(
        (message) => message.role === 'assistant' && message.status === 'complete',
      ),
    ).toHaveLength(3),
  );
  expect(
    (await history())
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ).toEqual(['Original task', 'Edited first', 'Second follow-up']);
  expect(seen).toHaveLength(3);
});

it('Stop pauses queued follow-ups; Send resumes the selected item', async () => {
  const running = chat();
  await waitFor(() => expect(held).toHaveLength(1));
  const first = await queue('First follow-up');
  const second = await queue('Send this first');
  await request('/bots/scout/stop', 'POST');
  await running;
  expect(seen).toHaveLength(1);
  expect((await request('/bots/scout/followups')).data).toHaveLength(2);
  mode = 'normal';
  await request('/bots/scout/followups', 'PUT', { action: 'send', id: second });
  await waitFor(async () =>
    expect(
      (await history()).filter(
        (message) => message.role === 'assistant' && message.status === 'complete',
      ),
    ).toHaveLength(2),
  );
  expect(
    (await history())
      .filter((message) => message.role === 'user')
      .map((message) => message.requestId),
  ).toEqual([expect.any(String), second, first]);
});

it('rejects stale steering, isolates conversations, and delivers a late steer as a follow-up', async () => {
  const requestId = randomUUID();
  const running = chat('Original task', requestId);
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Correction');
  expect((await steer(id, randomUUID())).status).toBe(409);
  const other = new ConversationRepository(api.store).createPrivate('default', 'scout');
  expect((await steer(id, requestId, '/conversations/' + other.id)).status).toBe(404);
  await request('/bots/scout/stop', 'POST');
  await running;
  mode = 'normal';
  expect((await steer(id, requestId)).status).toBe(200);
  await waitFor(async () => expect((await history()).at(-1)?.status).toBe('complete'));
  expect(
    (await history()).filter((message) => message.requestId === id && message.role === 'user'),
  ).toHaveLength(1);
});

it('applies steering after a running tool, preserving its result without replay or cancellation', async () => {
  await request('/approvals', 'PUT', { mode: 'full-access' });
  let release!: () => void;
  let toolSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = vi
    .spyOn(api.browsers, 'execute')
    .mockImplementation(async (_owner, _input, signal) => {
      toolSignal = signal;
      await gate;
      return { summary: 'Saved tool result' };
    });
  mode = 'tool';
  const requestId = randomUUID();
  const running = chat('Run one operation', requestId);
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
  const id = await queue('Use the completed result and change direction');
  const later = await queue('A second correction');
  const cancelled = await queue('Cancelled correction');
  try {
    expect((await steer(later, requestId)).status).toBe(200);
    expect((await steer(id, requestId)).status).toBe(200);
    expect((await steer(cancelled, requestId)).status).toBe(200);
    await request('/bots/scout/followups', 'PUT', { action: 'delete', id: cancelled });
    expect(toolSignal?.aborted).toBe(false);
    expect((await request('/bots/scout/followups')).data[0].state).toBe('steering');
    expect(seen).toHaveLength(1);
  } finally {
    release();
  }
  const events = await running;
  expect(events.at(-1)).toMatchObject({ type: 'done', message: { status: 'complete' } });
  expect(operation).toHaveBeenCalledTimes(1);
  const next = seen[1].messages;
  expect(
    next.filter((message) => message.role === 'tool' && message.tool_call_id === 'slow-call'),
  ).toHaveLength(1);
  expect(JSON.stringify(next)).toContain('Saved tool result');
  expect(next.at(-1)).toMatchObject({
    role: 'user',
    content: 'Use the completed result and change direction',
  });
  expect(next.at(-2)).toMatchObject({ role: 'user', content: 'A second correction' });
  expect(JSON.stringify(next)).not.toContain('Cancelled correction');
});

it('retains stopped queues across a backend restart without starting work unexpectedly', async () => {
  const running = chat();
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Saved follow-up');
  await request('/bots/scout/stop', 'POST');
  await running;
  await api.shutdown();
  await close(api.server);
  api.dispose();
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  expect((await request('/bots/scout/followups')).data).toMatchObject([
    { id, text: 'Saved follow-up', state: 'queued' },
  ]);
  expect(seen).toHaveLength(1);
  mode = 'normal';
  await request('/bots/scout/followups', 'PUT', { action: 'send', id });
  await waitFor(async () => expect((await history()).at(-1)?.status).toBe('complete'));
});

it('supports private conversation endpoints and rejects blank or oversized follow-ups', async () => {
  const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
  const root = '/conversations/' + conversation.id;
  const requestId = randomUUID();
  const running = chat('Private task', requestId, root);
  await waitFor(() => expect(held).toHaveLength(1));
  expect(
    (await request(root + '/followups', 'POST', { id: randomUUID(), text: '  ' })).status,
  ).toBe(400);
  expect(
    (await request(root + '/followups', 'POST', { id: randomUUID(), text: 'x'.repeat(16001) }))
      .status,
  ).toBe(400);
  const id = await queue('Private correction', root);
  mode = 'normal';
  expect((await steer(id, requestId, root)).status).toBe(200);
  await running;
  expect((await history(root)).at(-1)?.parts).toContainEqual(
    expect.objectContaining({
      id,
      type: 'steering',
      text: 'Private correction',
    }),
  );
  expect((await request('/bots/scout/followups')).data).toEqual([]);
});

it('pauses the remaining queue after a queued response fails', async () => {
  const running = chat();
  await waitFor(() => expect(held).toHaveLength(1));
  await queue('This response will fail');
  const remaining = await queue('Wait for explicit resume');
  mode = 'fail';
  held[0].finish();
  await running;
  await waitFor(async () => expect((await history()).at(-1)?.status).toBe('failed'));
  expect(seen).toHaveLength(2);
  expect((await request('/bots/scout/followups')).data).toMatchObject([
    { id: remaining, state: 'queued' },
  ]);
  mode = 'normal';
  await request('/bots/scout/followups', 'PUT', { action: 'send', id: remaining });
  await waitFor(async () => expect((await history()).at(-1)?.status).toBe('complete'));
});

it('resumes a durable queue saved just before a backend restart after successful completion', async () => {
  mode = 'normal';
  await chat();
  const id = randomUUID();
  new ChatFollowupRepository(api.store).enqueue('bot-scout', 'scout', id, 'Continue after restart');
  await api.shutdown();
  await close(api.server);
  api.dispose();
  api = await startApiServer(0, { dataDir: dir, memoryExtractor: async () => ({ facts: [] }) });
  await waitFor(async () =>
    expect(
      (await history()).filter(
        (message) => message.role === 'assistant' && message.status === 'complete',
      ),
    ).toHaveLength(2),
  );
  expect(
    (await history()).filter((message) => message.requestId === id && message.role === 'user'),
  ).toHaveLength(1);
  expect((await request('/bots/scout/followups')).data).toEqual([]);
});

it('recovers a separate overload at each model step without replaying completed tools', async () => {
  mode = 'overload-tools';
  await request('/approvals', 'PUT', { mode: 'full-access' });
  const operation = vi
    .spyOn(api.browsers, 'execute')
    .mockResolvedValue({ summary: 'Completed once' });
  const events = await chat('Continue through intermittent overloads');
  expect(events.at(-1)).toMatchObject({ type: 'done', message: { status: 'complete' } });
  expect(operation).toHaveBeenCalledTimes(3);
  expect(seen).toHaveLength(8);
  expect(
    (await history()).at(-1)?.activity?.filter((item) => item.status === 'complete'),
  ).toHaveLength(3);
}, 15000);

it('delivers a steer exactly once when it races the final message of a pass', async () => {
  const requestId = randomUUID();
  const running = chat('Finish this pass', requestId);
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Include this final correction');
  mode = 'normal';
  const steering = steer(id, requestId);
  held[0].finish();
  expect((await steering).status).toBe(200);
  await running;
  await waitFor(async () => expect((await request('/bots/scout/followups')).data).toEqual([]));
  await waitFor(async () => expect((await history()).at(-1)?.status).toBe('complete'));
  const messages = await history();
  const regular = messages.filter((message) => message.role === 'user' && message.requestId === id);
  const applied = messages
    .flatMap((message) => message.parts || [])
    .filter((part) => part.type === 'steering' && part.id === id);
  expect(regular.length + applied.length).toBe(1);
  expect(seen).toHaveLength(2);
  expect(JSON.stringify(seen.at(-1)!.messages)).toContain('Include this final correction');
});

it('treats a repeated late Steer click as delivered when the queue became a normal follow-up', async () => {
  const requestId = randomUUID();
  const running = chat('Finish first', requestId);
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Normal follow-up after completion');
  mode = 'normal';
  held[0].finish();
  await running;
  await waitFor(async () =>
    expect(
      (await history()).filter(
        (message) => message.role === 'assistant' && message.status === 'complete',
      ),
    ).toHaveLength(2),
  );
  expect((await steer(id, requestId)).status).toBe(200);
  expect((await steer(id, requestId)).status).toBe(200);
  expect(
    (await history()).filter((message) => message.role === 'user' && message.requestId === id),
  ).toHaveLength(1);
  expect(
    (await history())
      .flatMap((message) => message.parts || [])
      .filter((part) => part.type === 'steering'),
  ).toHaveLength(0);
  expect(seen).toHaveLength(2);
});

it('recovers timestamps for steering saved before the message timestamp field existed', async () => {
  const requestId = randomUUID();
  const running = chat('Original request', requestId);
  await waitFor(() => expect(held).toHaveLength(1));
  const id = await queue('Older saved correction');
  mode = 'normal';
  await steer(id, requestId);
  await running;
  const reply = (await history()).at(-1)!;
  const legacy = reply.parts?.map((part) =>
    part.type === 'steering' ? { id: part.id, type: part.type, text: part.text } : part,
  );
  api.store.run('UPDATE messages SET parts_json=? WHERE id=?', JSON.stringify(legacy), reply.id);
  const timestamp = api.store.get(
    'SELECT created_at FROM chat_followups WHERE id=?',
    id,
  )?.created_at;
  expect((await history()).at(-1)?.parts).toContainEqual({
    id,
    type: 'steering',
    text: 'Older saved correction',
    createdAt: timestamp,
  });
});
