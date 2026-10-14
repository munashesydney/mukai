import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import { BotRepository } from '../repositories/botRepository';
import { ConversationRepository } from '../repositories/conversationRepository';
import { Database } from '../db/database';
import { scoutBot } from '../services/botService';
import { TelegramClient, TelegramApiError } from './client';
import type { ChatInput, ChatMessage } from '../../shared/ai';
import type { TelegramUpdate } from './types';

const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
const OWNER = 987654321;
let folder: string;
let api: Awaited<ReturnType<typeof startApiServer>>;
let serial: number;
let calls: { method: string; input: Record<string, unknown>; init: RequestInit }[];

const telegramFetch: typeof fetch = async (input, init) => {
  const method = String(input).split('/').at(-1)!;
  const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
  calls.push({ method, input: body, init: init ?? {} });
  if (method === 'getUpdates') {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new Error('Poll aborted.'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  const result =
    method === 'getMe'
      ? { id: 123456789, is_bot: true, first_name: 'Mukai', username: 'MukaiTestBot' }
      : method === 'getWebhookInfo'
        ? { url: '' }
        : method === 'sendMessage'
          ? { message_id: 1000 + calls.length }
          : true;
  return Response.json({ ok: true, result });
};

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'mukai-telegram-'));
  serial = 0;
  calls = [];
  api = await startApiServer(0, {
    dataDir: folder,
    telegramFetch,
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestBot(api.store);
});

async function close() {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  expect(folder.startsWith(join(tmpdir(), 'mukai-telegram-'))).toBe(true);
  await rm(folder, { recursive: true, force: true });
});

function message(
  text: string,
  userId = OWNER,
  chatType = 'private',
  date = Math.floor(Date.now() / 1000),
): TelegramUpdate {
  const id = ++serial;
  return {
    update_id: id,
    message: {
      message_id: id,
      date,
      chat: { id: userId, type: chatType },
      from: { id: userId, is_bot: false, first_name: 'Owner' },
      text,
    },
  };
}

function accept(...updates: TelegramUpdate[]) {
  api.telegram.accept(api.telegram.connection()!.id, updates);
}

async function paired() {
  await api.telegram.connect(TOKEN);
  const pairing = api.telegram.pairing();
  accept(message('/start ' + pairing.pairing!.code));
  api.telegram.approve(OWNER);
  await api.telegram.setAccess({ workspaces: [{ workspaceId: 'default', botId: null }] });
}

async function choose(workspaceId = 'default') {
  accept(message('/workspaces'));
  await vi.waitFor(() => {
    expect(
      api.store.get(
        'SELECT markup_json FROM telegram_outbox WHERE markup_json IS NOT NULL ORDER BY sequence DESC',
      )?.markup_json,
    ).toBeTruthy();
    expect(api.telegram.jobs.inbox()).toHaveLength(0);
  });
  const row = api.store.get(
    'SELECT markup_json FROM telegram_outbox WHERE markup_json IS NOT NULL ORDER BY sequence DESC',
  )!;
  const markup = JSON.parse(String(row.markup_json)) as {
    inline_keyboard: { callback_data: string }[][];
  };
  const callback = markup.inline_keyboard
    .flat()
    .find((value) => value.callback_data.startsWith(`w:${workspaceId}:`))!.callback_data;
  const update: TelegramUpdate = {
    update_id: ++serial,
    callback_query: {
      id: 'callback-' + serial,
      from: { id: OWNER, is_bot: false, first_name: 'Owner' },
      data: callback,
      message: {
        message_id: serial,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER, type: 'private' },
      },
    },
  };
  accept(update);
  await vi.waitFor(() => {
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)?.workspaceId).toBe(
      workspaceId,
    );
  });
  return update;
}

function answer(input: ChatInput, content = 'A public answer.'): ChatMessage {
  return {
    id: 'assistant-' + input.requestId,
    requestId: input.requestId,
    botId: 'scout',
    role: 'assistant',
    content,
    status: 'complete',
    error: null,
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}

describe('Telegram management security', () => {
  it('requires the existing API credentials and trusted origin on every management endpoint', async () => {
    for (const [path, method] of [
      ['/telegram', 'GET'],
      ['/telegram/connect', 'POST'],
      ['/telegram/pairing/approve', 'POST'],
    ] as const) {
      expect((await fetch(api.url + path, { method })).status).toBe(401);
      expect(
        (
          await fetch(api.url + path, {
            method,
            headers: { Authorization: 'Bearer ' + api.token, Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await fetch(api.url + '/telegram', { headers: { Authorization: 'Bearer ' + api.token } }))
        .status,
    ).toBe(200);
    expect(calls).toEqual([]);
  });

  it('encrypts the token and requires explicit approval of the exact one-time pairing candidate', async () => {
    await api.telegram.connect(TOKEN);
    const status = api.telegram.pairing();
    const code = status.pairing!.code!;
    const stored = api.store.get('SELECT * FROM telegram_connections')!;
    expect(String(stored.encrypted_token)).not.toContain(TOKEN);
    expect(String(stored.pairing_hash)).not.toBe(code);
    expect(JSON.stringify(stored)).not.toContain(code);
    accept(message('/start wrong'), message('/workspaces'), message('/start ' + code));
    expect(api.telegram.status().owner).toBeNull();
    expect(api.telegram.status().pairing?.candidate?.id).toBe(OWNER);
    expect(api.telegram.status().pairing?.code).toBeUndefined();
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(() => api.telegram.approve(OWNER + 1)).toThrow(/changed or expired/);
    accept(message('/start ' + code, OWNER + 1));
    expect(api.telegram.status().pairing?.candidate?.id).toBe(OWNER);
    api.telegram.approve(OWNER);
    expect(() => api.telegram.approve(OWNER)).toThrow(/changed or expired/);
    expect(JSON.stringify(api.telegram.status())).not.toContain(TOKEN);
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('expires pairing links and does not trust strangers, groups, or messages from before approval', async () => {
    await api.telegram.connect(TOKEN);
    const expired = api.telegram.pairing().pairing!.code!;
    api.store.run('UPDATE telegram_connections SET pairing_expires_at=?', Date.now() - 1);
    accept(message('/start ' + expired));
    expect(api.telegram.status().pairing).toBeNull();
    expect(api.telegram.connection()!.candidate).toBeNull();
    const code = api.telegram.pairing().pairing!.code!;
    accept(message('/start ' + code));
    api.telegram.approve(OWNER);
    await api.telegram.setAccess({ workspaces: [{ workspaceId: 'default', botId: null }] });
    const mismatched = message('/workspaces');
    mismatched.message!.from!.id = OWNER + 1;
    accept(
      message('/workspaces', OWNER + 1),
      message('/workspaces', OWNER, 'group'),
      message('/workspaces', OWNER, 'private', 1),
      mismatched,
    );
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(api.telegram.sessions.all()).toEqual([]);
  });

  it('does not propagate credentials from failed fetches or raw Telegram error descriptions', async () => {
    const transport: typeof fetch = async () => {
      throw new Error(`https://api.telegram.org/bot${TOKEN}/getMe`);
    };
    await expect(new TelegramClient(TOKEN, transport).identity()).rejects.toThrow(TelegramApiError);
    try {
      await new TelegramClient(TOKEN, transport).identity();
    } catch (error) {
      expect(JSON.stringify(error) + String(error)).not.toContain(TOKEN);
    }
    const rejected: typeof fetch = async () =>
      Response.json({ ok: false, error_code: 401, description: TOKEN }, { status: 401 });
    await expect(new TelegramClient(TOKEN, rejected).identity()).rejects.toThrow(
      'Telegram rejected the bot token',
    );
    const oversized: typeof fetch = async () => new Response('x'.repeat(1024 * 1024 + 1));
    await expect(new TelegramClient(TOKEN, oversized).identity()).rejects.toThrow(TelegramApiError);
  });
});

describe('Telegram sessions and durable work', () => {
  it('streams a real local provider response into Telegram drafts, final delivery, and persistent conversation history', async () => {
    const providerInputs: unknown[] = [];
    let finishProvider: (() => void) | undefined;
    const fixture = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      providerInputs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (content: string, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'telegram-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-chat',
            choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
          })}\n\n`,
        );
      send('Real streamed answer. ');
      finishProvider = () => {
        if (response.destroyed) return;
        send('Finished safely.', 'stop');
        response.end('data: [DONE]\n\n');
      };
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
      const configured = await fetch(api.url + '/providers', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local Telegram fixture',
          kind: 'compatible',
          baseUrl: endpoint,
          defaultModel: 'test-chat',
          isDefault: true,
          supportsImages: false,
          models: [
            {
              id: 'test-chat',
              name: 'Fixture',
              contextWindowTokens: 32768,
              maxOutputTokens: 4096,
              supportsImages: false,
            },
          ],
        }),
      });
      expect(configured.status).toBe(201);
      await paired();
      await choose();
      const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
      await vi.waitFor(
        () =>
          expect(
            api.store.all("SELECT id FROM telegram_outbox WHERE state IN ('pending','sending')"),
          ).toEqual([]),
        { timeout: 7000 },
      );
      accept(message('Reply through the real AI runtime.'));
      await vi.waitFor(
        () =>
          expect(
            calls.some(
              (call) =>
                call.method === 'sendMessageDraft' && call.input.text === 'Real streamed answer. ',
            ),
          ).toBe(true),
        { timeout: 7000 },
      );
      expect(finishProvider).toBeTypeOf('function');
      finishProvider!();
      await vi.waitFor(() => expect(api.telegram.jobs.jobs('done')).toHaveLength(1));
      await vi.waitFor(
        () =>
          expect(
            calls.some(
              (call) =>
                call.method === 'sendMessage' &&
                call.input.text === 'Real streamed answer. Finished safely.',
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      const history = api.telegram.conversations.history(session.conversationId);
      expect(history.filter((item) => item.role === 'user')).toHaveLength(1);
      expect(history.find((item) => item.role === 'user')?.content).toBe(
        'Reply through the real AI runtime.',
      );
      expect(api.telegram.conversations.require(session.conversationId).name).toBe(
        'Reply through the real AI runtime.',
      );
      const user = history.find((item) => item.role === 'user')!;
      expect(api.store.get('SELECT content,source FROM messages WHERE id=?', user.id)).toEqual({
        content: 'Reply through the real AI runtime.',
        source: 'telegram',
      });
      expect(
        (
          await fetch(api.url + '/conversations/' + session.conversationId + '/messages', {
            headers: { Authorization: 'Bearer ' + api.token },
          })
        ).status,
      ).toBe(200);
      expect(history.find((item) => item.role === 'assistant')).toMatchObject({
        status: 'complete',
        content: 'Real streamed answer. Finished safely.',
      });
      expect(providerInputs).toHaveLength(1);
      expect(JSON.stringify(providerInputs)).toContain('Reply through the real AI runtime.');
      expect(JSON.stringify(providerInputs)).toContain(
        'Message coming from the Telegram integration by the user.\\n\\nReply through the real AI runtime.',
      );
      expect(JSON.stringify(providerInputs)).toContain(
        'Mukai has a built-in Telegram integration.',
      );
      expect(JSON.stringify(providerInputs)).not.toContain(TOKEN);
    } finally {
      finishProvider?.();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 20000);

  it('forwards the final public answer and approval notice while keeping reasoning and tool details local', async () => {
    await paired();
    await choose();
    vi.spyOn(api.telegram.conversations, 'sendPrivate').mockImplementation(
      async (_conversationId, input, output) => {
        output.start();
        output.emit({ type: 'reasoning', id: 'assistant', text: 'private-reasoning-secret' });
        output.emit({ type: 'approval', id: 'assistant' });
        const message = answer(input, 'legacy-content-including-process');
        message.reasoning = 'private-reasoning-secret';
        message.parts = [
          { id: 'reason', type: 'reasoning', text: 'private-reasoning-secret' },
          { id: 'commentary', type: 'text', text: 'internal-process-commentary' },
          { id: 'call', type: 'tool', activityId: 'private-tool-result-secret' },
          { id: 'final', type: 'text', text: 'Only this public answer.', final: true },
        ];
        output.emit({ type: 'done', message });
      },
    );
    accept(message('Do the work'));
    await vi.waitFor(() => expect(api.telegram.jobs.jobs('done')).toHaveLength(1));
    const content = JSON.stringify(api.store.all('SELECT text FROM telegram_outbox'));
    expect(content).toContain('Only this public answer.');
    expect(content).toContain('needs your approval in Mukai');
    for (const secret of [
      'private-reasoning-secret',
      'internal-process-commentary',
      'private-tool-result-secret',
      'legacy-content-including-process',
    ]) {
      expect(content).not.toContain(secret);
      expect(JSON.stringify(calls)).not.toContain(secret);
    }
  });

  it('selects workspaces inside the inbox transaction and keeps Telegram separate from empty desktop chats', async () => {
    const desktop = new ConversationRepository(api.store).createPrivate('default', 'scout');
    await paired();
    await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    expect(session.conversationId).not.toBe(desktop.id);
    accept(message('/new'));
    await vi.waitFor(() =>
      expect(api.telegram.sessions.current(session.connectionId, OWNER)!.conversationId).not.toBe(
        session.conversationId,
      ),
    );
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('pins queued messages to their workspace and conversation, and deduplicates repeated updates', async () => {
    new WorkspaceRepository(api.store).create({
      id: 'other',
      name: 'Other',
      folder: null,
      computer: 'local',
      createdAt: new Date().toISOString(),
    });
    new BotRepository(api.store).create(scoutBot('other', 'other-bot'));
    await paired();
    await api.telegram.setAccess({
      workspaces: [
        { workspaceId: 'default', botId: null },
        { workspaceId: 'other', botId: null },
      ],
    });
    await choose();
    const first = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    const received: { conversationId: string; text: string }[] = [];
    const send = vi
      .spyOn(api.telegram.conversations, 'sendPrivate')
      .mockImplementation(async (conversationId, input, output) => {
        received.push({ conversationId, text: input.text });
        output.emit({ type: 'done', message: answer(input) });
      });
    const queued = message('Message for the first workspace');
    accept(queued, queued);
    await choose('other');
    const second = api.telegram.sessions.current(first.connectionId, OWNER)!;
    const next = message('Message for the second workspace');
    accept(next, queued);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(received).toEqual(
      expect.arrayContaining([
        {
          conversationId: first.conversationId,
          text: queued.message!.text,
        },
        {
          conversationId: second.conversationId,
          text: next.message!.text,
        },
      ]),
    );
    expect(api.store.all('SELECT * FROM telegram_chat_jobs')).toHaveLength(2);
    expect(api.telegram.connection()!.nextOffset).toBe(next.update_id + 1);
    expect(api.store.all("SELECT * FROM telegram_outbox WHERE id LIKE '%:0'")).toHaveLength(2);
  });

  it('processes /stop while AI is pending, clears queued turns, and suppresses a cancelled response', async () => {
    await paired();
    await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi
      .spyOn(api.telegram.conversations, 'sendPrivate')
      .mockImplementation(async (_conversationId, input, output) => {
        await blocked;
        output.emit({ type: 'done', message: answer(input, 'Must not be delivered after stop.') });
      });
    accept(message('A long operation'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    accept(message('Queued follow-up'), message('/stop'));
    try {
      await vi.waitFor(() => {
        expect(api.telegram.jobs.jobs('running')).toEqual([]);
        expect(api.telegram.jobs.jobs('queued')).toEqual([]);
      });
      release();
      await vi.waitFor(() =>
        expect(
          api.store.get(
            "SELECT COUNT(*) AS n FROM telegram_outbox WHERE text LIKE 'Stopped the current%'",
          )?.n,
        ).toBe(1),
      );
      expect(
        api.store.get(
          'SELECT id FROM telegram_outbox WHERE text=?',
          'Must not be delivered after stop.',
        ),
      ).toBeUndefined();
      expect(send).toHaveBeenCalledOnce();
      expect(api.telegram.sessions.current(session.connectionId, OWNER)!.conversationId).toBe(
        session.conversationId,
      );
    } finally {
      release();
    }
  });

  it('revalidates workspace access and invalidates callbacks after unpairing', async () => {
    await paired();
    const oldCallback = await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    api.telegram.jobs.enqueue(session, 'Queued before revocation', 900, 'revoked-job');
    api.telegram.jobs.queue(
      {
        connectionId: session.connectionId,
        chatId: OWNER,
        text: 'Private queued reply',
        workspaceId: 'default',
        botId: 'scout',
      },
      'revoked-delivery',
    );
    const send = vi.spyOn(api.telegram.conversations, 'sendPrivate');
    await api.telegram.setAccess({ workspaces: [] });
    expect(api.telegram.sessions.all()).toEqual([]);
    expect(
      api.store.get('SELECT state FROM telegram_outbox WHERE id=?', 'revoked-delivery')?.state,
    ).toBe('cancelled');
    expect(send).not.toHaveBeenCalled();
    await api.telegram.disconnect(true);
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(api.telegram.sessions.all()).toEqual([]);
    expect(api.store.all('SELECT * FROM telegram_chat_jobs')).toEqual([]);
    accept({ ...oldCallback, update_id: ++serial });
    expect(api.telegram.jobs.inbox()).toEqual([]);
    expect(api.telegram.status().owner).toBeNull();
  });

  it('cancels queued work and rejects old callbacks when the followed main bot changes', async () => {
    await paired();
    const oldCallback = await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    api.telegram.jobs.enqueue(session, 'Do not run on the former main bot', 700, 'old-main-job');
    api.store.run('UPDATE bots SET is_main=0 WHERE id=?', 'scout');
    new BotRepository(api.store).create(scoutBot('default', 'replacement-main'));
    const send = vi.spyOn(api.telegram.conversations, 'sendPrivate');
    expect(
      api.telegram.deliveryAllowed({
        id: 'old-reply',
        connectionId: session.connectionId,
        chatId: OWNER,
        text: 'Private reply from the former main bot',
        workspaceId: 'default',
        botId: 'scout',
        attempts: 0,
      }),
    ).toBe(false);
    accept({ ...oldCallback, update_id: ++serial });
    await vi.waitFor(() => {
      expect(
        api.store.get('SELECT state FROM telegram_chat_jobs WHERE id=?', 'old-main-job')?.state,
      ).toBe('cancelled');
      expect(api.telegram.jobs.inbox()).toEqual([]);
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      api.store.get(
        "SELECT text FROM telegram_outbox WHERE text LIKE 'This workspace selection expired%'",
      )?.text,
    ).toBeTruthy();
    await choose();
    expect(api.telegram.sessions.current(session.connectionId, OWNER)?.botId).toBe(
      'replacement-main',
    );
    expect(api.telegram.sessions.current(session.connectionId, OWNER)?.conversationId).not.toBe(
      session.conversationId,
    );
  });

  it('invalidates old workspace buttons even when the same account pairs again in the same second', async () => {
    await paired();
    const oldCallback = await choose();
    const authorizationId = api.telegram.connection()!.authorizationId;
    const authorizedAt = api.telegram.connection()!.authorizedAt;
    await api.telegram.disconnect(true);
    const pairing = api.telegram.pairing();
    accept(message('/start ' + pairing.pairing!.code));
    api.telegram.approve(OWNER);
    api.store.run('UPDATE telegram_connections SET authorized_at=?', authorizedAt);
    expect(api.telegram.connection()!.authorizationId).not.toBe(authorizationId);
    accept({ ...oldCallback, update_id: ++serial });
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toEqual([]));
    expect(api.telegram.sessions.all()).toEqual([]);
    expect(
      api.store.get(
        "SELECT text FROM telegram_outbox WHERE text LIKE 'This workspace selection expired%'",
      ),
    ).toBeTruthy();
  });

  it('marks interrupted running work after restart without replaying AI or tool side effects', async () => {
    await paired();
    await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    await close();
    const database = new Database(folder);
    database.run(
      `INSERT INTO telegram_chat_jobs(id,connection_id,session_id,conversation_id,workspace_id,bot_id,chat_id,source_message_id,text,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'running',?)`,
      'crash-request',
      session.connectionId,
      session.id,
      session.conversationId,
      session.workspaceId,
      session.botId,
      OWNER,
      800,
      'Already started an external action',
      Date.now(),
    );
    database.run(
      "INSERT INTO telegram_outbox(id,connection_id,chat_id,text,state,created_at) VALUES(?,?,?,?,'sending',?)",
      'uncertain',
      session.connectionId,
      OWNER,
      'A reply with an unknown delivery result',
      Date.now(),
    );
    database.db.close();
    api = await startApiServer(0, { dataDir: folder, telegramFetch });
    const send = vi.spyOn(api.telegram.conversations, 'sendPrivate');
    await vi.waitFor(() =>
      expect(
        api.store.get('SELECT state FROM telegram_chat_jobs WHERE id=?', 'crash-request')?.state,
      ).toBe('interrupted'),
    );
    expect(send).not.toHaveBeenCalled();
    expect(api.store.get('SELECT state FROM telegram_outbox WHERE id=?', 'uncertain')?.state).toBe(
      'uncertain',
    );
    expect(
      api.store.get('SELECT text FROM telegram_outbox WHERE id=?', 'crash-request:0')?.text,
    ).toMatch(/review the saved progress/);
    expect(
      calls.filter(
        (call) =>
          call.method === 'sendMessage' &&
          call.input.text === 'A reply with an unknown delivery result',
      ),
    ).toEqual([]);
    const rawFile = await readFile(join(folder, 'mukai.sqlite'));
    expect(rawFile.includes(Buffer.from(TOKEN))).toBe(false);
  });

  it('preserves accepted unstarted turns through orderly shutdown and runs them once after restart', async () => {
    await paired();
    await choose();
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    const incoming = message('Keep this queued turn across restart');
    accept(incoming);
    for (const value of api.telegram.jobs.inbox()) {
      api.telegram.jobs.consumeInbox(value.sequence, () =>
        api.telegram.dispatch(value.connectionId, value.update),
      );
    }
    const queued = api.telegram.jobs.jobs('queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].conversationId).toBe(session.conversationId);
    await close();
    api = await startApiServer(0, {
      dataDir: folder,
      telegramFetch,
      memoryExtractor: async () => ({ facts: [] }),
    });
    expect(api.telegram.jobs.jobs('queued').map((job) => job.id)).toEqual([queued[0].id]);
    const send = vi
      .spyOn(api.telegram.conversations, 'sendPrivate')
      .mockImplementation(async (conversationId, input, output) => {
        expect(conversationId).toBe(session.conversationId);
        expect(input.text).toBe(incoming.message!.text);
        expect(input.requestId).toBe(queued[0].id);
        output.emit({ type: 'done', message: answer(input, 'Resumed the unstarted turn.') });
      });
    await vi.waitFor(() =>
      expect(api.telegram.jobs.jobs('done').map((job) => job.id)).toEqual([queued[0].id]),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(api.telegram.connection()!.nextOffset).toBe(incoming.update_id + 1);
    expect(
      api.store.get('SELECT text FROM telegram_outbox WHERE id=?', queued[0].id + ':0')?.text,
    ).toBe('Resumed the unstarted turn.');
  });
});
