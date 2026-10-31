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
  it('reports prompt connection status only for paired, enabled and authorized workspaces', async () => {
    expect(api.telegram.workspaceConnected('default')).toBe(false);
    await paired();
    expect(api.telegram.workspaceConnected('default')).toBe(true);
    const other = api.workspaces.create({ name: 'Other', folder: tmpdir() });
    expect(api.telegram.workspaceConnected(other.id)).toBe(false);
    api.telegram.connections.enabled(false);
    expect(api.telegram.workspaceConnected('default')).toBe(false);
    api.telegram.connections.enabled(true);
    expect(api.telegram.workspaceConnected('default')).toBe(true);
    await api.telegram.setAccess({ workspaces: [] });
    expect(api.telegram.workspaceConnected('default')).toBe(false);
    await api.telegram.setAccess({ workspaces: [{ workspaceId: 'default', botId: null }] });
    api.telegram.connections.revoke();
    expect(api.telegram.workspaceConnected('default')).toBe(false);
  });

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
                call.method === 'sendMessageDraft' &&
                call.input.text === 'Workspace Test workspace\nBot Scout\n\nReal streamed answer. ',
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
                call.input.text ===
                  'Workspace Test workspace\nBot Scout\n\nReal streamed answer. Finished safely.',
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
      expect(user.source).toBe('telegram');
      expect(history.find((item) => item.role === 'assistant')?.source).toBeUndefined();
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
      expect(JSON.stringify(providerInputs)).not.toContain('Workspace Test workspace');
    } finally {
      finishProvider?.();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 20000);

  it('forwards the final public answer while keeping reasoning and tool results local', async () => {
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
    expect(content).not.toContain('needs your approval in Mukai');
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

function pendingApproval(
  botId = 'scout',
  input: unknown = { action: 'run', command: 'echo safe' },
) {
  const bot = new BotRepository(api.store).find(botId)!;
  const conversation = new ConversationRepository(api.store).createPrivate(bot.workspaceId, botId);
  const id = 'activity-' + ++serial;
  api.store.run(
    `INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id)
    VALUES(?,?,?,'assistant','','streaming',?,?)`,
    id,
    botId,
    id,
    new Date().toISOString(),
    conversation.id,
  );
  const details = {
    botId,
    botName: bot.name,
    conversationId: conversation.id,
    messageId: id,
    toolCallId: id,
    batchId: id,
    toolName: 'computer_use',
    input,
  };
  const controller = new AbortController();
  const decision = api.approvals
    .request(details, controller.signal, () => {}, true)
    .catch(() => false);
  return {
    details,
    decision,
    controller,
    request: api.approvals.state().pending.find((item) => item.messageId === id)!,
  };
}
async function postedEvent(sourceId: string) {
  await vi.waitFor(
    () =>
      expect(
        api.store.get('SELECT id FROM telegram_events WHERE source_id=?', sourceId),
      ).toBeTruthy(),
    { timeout: 5000 },
  );
  return api.store.get('SELECT * FROM telegram_events WHERE source_id=?', sourceId)!;
}
function tap(eventId: string, action: string, userId = OWNER, chatType = 'private') {
  const id = ++serial;
  const update: TelegramUpdate = {
    update_id: id,
    callback_query: {
      id: 'tap-' + id,
      from: { id: userId, first_name: 'Owner' },
      data: `t:${eventId}:${action}`,
      message: {
        message_id: 10000 + id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: chatType },
      },
    },
  };
  accept(update);
  return update;
}
function notify(botId = 'scout', title = 'A finding') {
  const bot = new BotRepository(api.store).find(botId)!;
  const conversation = new ConversationRepository(api.store).createPrivate(bot.workspaceId, botId);
  const id = 'notification-source-' + ++serial;
  api.store.run(
    `INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id)
    VALUES(?,?,?,'assistant','A finding from autonomous work.','complete',?,?)`,
    id,
    botId,
    id,
    new Date().toISOString(),
    conversation.id,
  );
  return api.notifications.notify(bot, id, id, {
    title,
    message: 'A finding from autonomous work.',
  }).notificationId;
}

describe('Telegram workspace approvals and updates', () => {
  it('forwards approvals from non-Telegram conversations and other bots, with scoped one-time decisions', async () => {
    await paired();
    new BotRepository(api.store).create({
      ...scoutBot('default', 'reviewer'),
      name: 'Reviewer',
      isMain: false,
    });
    const pending = pendingApproval('reviewer', {
      command: 'echo safe',
      password: 'do-not-forward-this',
      nested: { api_key: 'do-not-forward-either' },
    });
    const event = await postedEvent(pending.request.id);
    expect(event.workspace_id).toBe('default');
    expect(event.bot_id).toBe('reviewer');
    const text = String(
      api.store.get('SELECT text FROM telegram_outbox WHERE event_id=?', String(event.id))!.text,
    );
    expect(text).not.toContain('Bot Reviewer');
    expect(api.telegram.messageText(text, 'default', 'reviewer')).toContain(
      'Workspace Test workspace\nBot Reviewer\n\n',
    );
    expect(text).toContain('echo safe');
    expect(text).not.toContain('do-not-forward');
    const decide = vi.spyOn(api.approvals, 'decide');
    tap(String(event.id), 'yes', OWNER + 1);
    tap(String(event.id), 'yes', OWNER, 'group');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(decide).not.toHaveBeenCalled();
    const update = tap(String(event.id), 'yes');
    expect(await pending.decision).toBe(true);
    accept(update);
    tap(String(event.id), 'yes');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(decide).toHaveBeenCalledOnce();
    expect(api.approvals.state().pending).toHaveLength(0);
  }, 15000);

  it('denies requests and rejects buttons after a decision made in Mukai', async () => {
    await paired();
    const denied = pendingApproval();
    const event = await postedEvent(denied.request.id);
    tap(String(event.id), 'no');
    expect(await denied.decision).toBe(false);
    const local = pendingApproval();
    const localEvent = await postedEvent(local.request.id);
    const original = api.store.get(
      'SELECT id FROM telegram_outbox WHERE event_id=?',
      String(localEvent.id),
    )!;
    api.telegram.jobs.delivered(String(original.id), 7654321);
    api.approvals.decide(local.request.id, true);
    expect(await local.decision).toBe(true);
    const decide = vi.spyOn(api.approvals, 'decide');
    tap(String(localEvent.id), 'yes');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(decide).not.toHaveBeenCalled();
    await vi.waitFor(
      () =>
        expect(
          api.store.get(
            'SELECT edit_message_id FROM telegram_outbox WHERE id=?',
            'clear:' + original.id,
          )?.edit_message_id,
        ).toBe(7654321),
      { timeout: 5000 },
    );
  }, 15000);

  it('waits for a denial reason, passes it to the asking bot, and rejects a late reason after approval', async () => {
    await paired();
    const initial = pendingApproval();
    api.approvals.decide(initial.request.id, false);
    await initial.decision;
    const ask = () =>
      api.approvals.ask(
        initial.details,
        { action: 'approval', question: 'May I publish?' },
        new AbortController().signal,
        () => {},
        () => {},
      );
    const response = ask();
    const pending = api.approvals.state().pending[0];
    const event = await postedEvent(pending.id);
    const markup = String(
      api.store.get('SELECT markup_json FROM telegram_outbox WHERE event_id=?', String(event.id))!
        .markup_json,
    );
    expect(markup).toContain('Deny with reason');
    tap(String(event.id), 'reason', OWNER + 1);
    tap(String(event.id), 'reason');
    await vi.waitFor(() =>
      expect(
        api.store.get(
          "SELECT id FROM telegram_outbox WHERE event_id=? AND reply_action='deny_reason'",
          String(event.id),
        ),
      ).toBeTruthy(),
    );
    expect(api.approvals.state().pending).toHaveLength(1);
    const prompt = api.store.get(
      "SELECT id FROM telegram_outbox WHERE event_id=? AND reply_action='deny_reason'",
      String(event.id),
    )!;
    api.telegram.jobs.delivered(String(prompt.id), 701111);
    const reply = message('  Review the draft first.  ');
    reply.message!.reply_to_message = { message_id: 701111 };
    accept(reply);
    expect(await response).toEqual({
      action: 'approval',
      approved: false,
      reason: 'Review the draft first.',
    });
    expect(api.store.all('SELECT id FROM telegram_chat_jobs')).toHaveLength(0);
    const second = ask();
    const secondEvent = await postedEvent(api.approvals.state().pending[0].id);
    tap(String(secondEvent.id), 'reason');
    await vi.waitFor(() =>
      expect(
        api.store.get(
          "SELECT id FROM telegram_outbox WHERE event_id=? AND reply_action='deny_reason'",
          String(secondEvent.id),
        ),
      ).toBeTruthy(),
    );
    const secondPrompt = api.store.get(
      "SELECT id FROM telegram_outbox WHERE event_id=? AND reply_action='deny_reason'",
      String(secondEvent.id),
    )!;
    api.telegram.jobs.delivered(String(secondPrompt.id), 701112);
    tap(String(secondEvent.id), 'yes');
    expect(await second).toEqual({ action: 'approval', approved: true });
    const late = message('Do not publish.');
    late.message!.reply_to_message = { message_id: 701112 };
    accept(late);
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(api.store.all('SELECT id FROM telegram_chat_jobs')).toHaveLength(0);
    expect(api.approvals.state().pending).toHaveLength(0);
  }, 15000);

  it('answers clarifications with options or a direct reply without passing the answer to an unrelated AI chat', async () => {
    await paired();
    const first = pendingApproval();
    // Replace the plain tool checkpoint with an explicit clarification for the same saved turn.
    api.approvals.decide(first.request.id, false);
    await first.decision;
    const question = {
      action: 'clarification' as const,
      question: 'Which branch?',
      options: [
        { label: 'Main', recommended: true },
        { label: 'Preview', recommended: false },
      ],
    };
    const answers: unknown[] = [];
    const response = api.approvals.ask(
      first.details,
      question,
      new AbortController().signal,
      () => {},
      (answer) => answers.push(answer),
    );
    const request = api.approvals.state().pending[0];
    const event = await postedEvent(request.id);
    tap(String(event.id), 'o1');
    expect(await response).toEqual({ action: 'clarification', answer: 'Preview' });
    expect(answers).toEqual([{ action: 'clarification', answer: 'Preview' }]);
    const next = pendingApproval();
    api.approvals.decide(next.request.id, false);
    await next.decision;
    const typed = api.approvals.ask(
      next.details,
      question,
      new AbortController().signal,
      () => {},
      () => {},
    );
    const typedEvent = await postedEvent(api.approvals.state().pending[0].id);
    tap(String(typedEvent.id), 'answer');
    await vi.waitFor(() =>
      expect(
        api.store.get(
          "SELECT id FROM telegram_outbox WHERE event_id=? AND json_extract(markup_json,'$.force_reply')=1",
          String(typedEvent.id),
        ),
      ).toBeTruthy(),
    );
    const prompt = api.store.get(
      "SELECT id FROM telegram_outbox WHERE event_id=? AND json_extract(markup_json,'$.force_reply')=1",
      String(typedEvent.id),
    )!;
    api.telegram.jobs.delivered(String(prompt.id), 444111);
    const reply = message('Use release/candidate.');
    reply.message!.reply_to_message = { message_id: 444111 };
    accept(reply);
    expect(await typed).toEqual({ action: 'clarification', answer: 'Use release/candidate.' });
    expect(api.store.all('SELECT text FROM telegram_chat_jobs')).toHaveLength(0);
  }, 15000);

  it('sends updates from all bots in an enabled workspace and continues with the correct bot and conversation', async () => {
    await paired();
    new BotRepository(api.store).create({
      ...scoutBot('default', 'researcher'),
      name: 'Researcher',
      isMain: false,
    });
    const id = notify('researcher');
    const event = await postedEvent(id);
    tap(String(event.id), 'continue');
    await vi.waitFor(() =>
      expect(
        api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)?.notificationId,
      ).toBe(id),
    );
    const session = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    expect(session.botId).toBe('researcher');
    expect(api.notifications.list('default').items[0].conversationId).toBe(session.conversationId);
    const send = vi
      .spyOn(api.telegram.conversations, 'sendPrivate')
      .mockImplementation(async (conversationId, input, output, source) => {
        expect(conversationId).toBe(session.conversationId);
        expect(input.text).toBe('Tell me more.');
        expect(source).toBe('telegram');
        output.emit({
          type: 'done',
          message: { ...answer(input, 'Here is the finding.'), botId: 'researcher' },
        });
      });
    accept(message('Tell me more.'));
    await vi.waitFor(() => expect(api.telegram.jobs.jobs('done')).toHaveLength(1));
    expect(send).toHaveBeenCalledOnce();
    expect(api.telegram.jobs.jobs('done')[0].notificationId).toBe(id);
    expect(api.telegram.messageText('Here is the finding.', 'default', 'researcher')).toBe(
      'Workspace Test workspace\nBot Researcher\n\nHere is the finding.',
    );
    expect(api.telegram.conversations.history(session.conversationId)[0].content).toBe(
      'A finding from autonomous work.',
    );
    await choose();
    expect(api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!.botId).toBe(
      'scout',
    );
  }, 15000);

  it('marks updates read or dismissed and does not resend them after restarting', async () => {
    await paired();
    const read = notify(),
      dismissed = notify('scout', 'Second finding'),
      unread = notify('scout', 'Unread finding');
    const readEvent = await postedEvent(read),
      dismissEvent = await postedEvent(dismissed);
    await postedEvent(unread);
    tap(String(readEvent.id), 'read');
    tap(String(dismissEvent.id), 'dismiss');
    await vi.waitFor(() => expect(api.notifications.list('default').unread).toBe(1));
    expect(api.notifications.list('default').total).toBe(2);
    await close();
    api = await startApiServer(0, {
      dataDir: folder,
      telegramFetch,
      memoryExtractor: async () => ({ facts: [] }),
    });
    const fresh = notify('scout', 'Finding after restart');
    await postedEvent(fresh);
    expect(
      api.store.all(
        "SELECT id FROM telegram_events WHERE kind='notification' AND source_id=?",
        unread,
      ),
    ).toHaveLength(1);
    expect(
      api.store.all(
        'SELECT id FROM telegram_outbox WHERE event_id=(SELECT id FROM telegram_events WHERE source_id=?) AND edit_message_id IS NULL',
        unread,
      ),
    ).toHaveLength(1);
  }, 15000);

  it('invalidates actions on access removal and never forwards activity from a disabled workspace', async () => {
    await paired();
    new WorkspaceRepository(api.store).create({
      id: 'hidden',
      name: 'Hidden',
      folder: null,
      createdAt: new Date().toISOString(),
      computer: 'local',
    });
    new BotRepository(api.store).create(scoutBot('hidden', 'hidden-bot'));
    const hidden = notify('hidden-bot');
    const pending = pendingApproval();
    const original = await postedEvent(pending.request.id);
    expect(
      api.store.get('SELECT id FROM telegram_events WHERE source_id=?', hidden),
    ).toBeUndefined();
    await api.telegram.setAccess({ workspaces: [] });
    tap(String(original.id), 'yes');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(api.approvals.state().pending).toHaveLength(1);
    await api.telegram.setAccess({ workspaces: [{ workspaceId: 'default', botId: null }] });
    const next = await postedEvent(pending.request.id);
    expect(next.id).not.toBe(original.id);
    tap(String(original.id), 'yes');
    tap(String(next.id), 'no');
    expect(await pending.decision).toBe(false);
    expect(
      api.store.get('SELECT id FROM telegram_events WHERE source_id=?', hidden),
    ).toBeUndefined();
  }, 15000);

  it('requires Mukai review for oversized approval payloads even when a callback is forged', async () => {
    await paired();
    const pending = pendingApproval('scout', { command: 'x'.repeat(14000) });
    const event = await postedEvent(pending.request.id);
    const markup = String(
      api.store.get('SELECT markup_json FROM telegram_outbox WHERE event_id=?', String(event.id))!
        .markup_json,
    );
    expect(markup).not.toContain(':yes');
    tap(String(event.id), 'yes');
    await vi.waitFor(() =>
      expect(
        api.store.get(
          "SELECT id FROM telegram_actions WHERE event_id=? AND state='done'",
          String(event.id),
        ),
      ).toBeTruthy(),
    );
    expect(api.approvals.state().pending).toHaveLength(1);
    tap(String(event.id), 'no');
    expect(await pending.decision).toBe(false);
  }, 15000);
});

describe('Telegram activity edge cases', () => {
  it('rejects old approval buttons after unpairing and pairing the same Telegram account again', async () => {
    await paired();
    const pending = pendingApproval();
    const oldEvent = await postedEvent(pending.request.id);
    const oldAuthorization = api.telegram.connection()!.authorizationId;
    await api.telegram.disconnect(true);
    const pairing = api.telegram.pairing();
    accept(message('/start ' + pairing.pairing!.code));
    api.telegram.approve(OWNER);
    expect(api.telegram.connection()!.authorizationId).not.toBe(oldAuthorization);
    const decide = vi.spyOn(api.approvals, 'decide');
    tap(String(oldEvent.id), 'yes');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(decide).not.toHaveBeenCalled();
    accept(message('/approvals'));
    await vi.waitFor(
      () =>
        expect(
          api.store.get(
            'SELECT id FROM telegram_events WHERE source_id=? AND authorization_id=?',
            pending.request.id,
            api.telegram.connection()!.authorizationId,
          ),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    const fresh = api.store.get(
      'SELECT id FROM telegram_events WHERE source_id=? AND authorization_id=?',
      pending.request.id,
      api.telegram.connection()!.authorizationId,
    )!;
    tap(String(fresh.id), 'no');
    expect(await pending.decision).toBe(false);
  }, 15000);

  it('routes a direct reply to an update and keeps the same bot when starting a fresh conversation', async () => {
    await paired();
    new BotRepository(api.store).create({ ...scoutBot('default', 'reporter'), isMain: false });
    const notificationId = notify('reporter');
    const event = await postedEvent(notificationId);
    const sent = api.store.get(
      'SELECT id FROM telegram_outbox WHERE event_id=?',
      String(event.id),
    )!;
    api.telegram.jobs.delivered(String(sent.id), 555222);
    const send = vi
      .spyOn(api.telegram.conversations, 'sendPrivate')
      .mockImplementation(async (_conversationId, input, output) => {
        expect(input.text).toBe('Explain the update.');
        output.emit({ type: 'done', message: { ...answer(input), botId: 'reporter' } });
      });
    const reply = message('Explain the update.');
    reply.message!.reply_to_message = { message_id: 555222 };
    accept(reply);
    await vi.waitFor(() => expect(api.telegram.jobs.jobs('done')).toHaveLength(1));
    expect(send).toHaveBeenCalledOnce();
    const previous = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    expect(previous.botId).toBe('reporter');
    accept(message('/new'));
    await vi.waitFor(() =>
      expect(
        api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)?.conversationId,
      ).not.toBe(previous.conversationId),
    );
    const fresh = api.telegram.sessions.current(api.telegram.connection()!.id, OWNER)!;
    expect(fresh.botId).toBe('reporter');
    expect(fresh.notificationId).toBe(notificationId);
    expect(api.telegram.sessionAllowed(fresh)).toBe(true);
    expect(api.telegram.conversations.history(fresh.conversationId)).toEqual([]);
  }, 15000);

  it('preserves old queued replies that need extra space for the new workspace header', async () => {
    await paired();
    const text = 'Old queued reply 📨 '.repeat(220);
    api.store.run(
      `INSERT INTO telegram_outbox(id,connection_id,chat_id,workspace_id,bot_id,text,created_at)
      VALUES('old-long-reply',?,?,'default','scout',?,?)`,
      api.telegram.connection()!.id,
      OWNER,
      text,
      Date.now(),
    );
    const value = api.telegram.jobs.delivery(Date.now());
    // Find the legacy row directly, independent of the pairing greeting ahead of it.
    expect(value).toBeTruthy();
    const legacy = {
      id: 'old-long-reply',
      connectionId: api.telegram.connection()!.id,
      chatId: OWNER,
      workspaceId: 'default',
      botId: 'scout',
      text,
      attempts: 0,
    };
    expect(api.telegram.jobs.splitPending(legacy)).toBe(true);
    const parts = api.store.all(
      "SELECT text FROM telegram_outbox WHERE id='old-long-reply' OR id LIKE 'old-long-reply:continued:%' ORDER BY sequence",
    );
    expect(parts.map((row) => row.text).join('')).toBe(text);
    for (const row of parts) {
      const formatted = api.telegram.messageText(String(row.text), 'default');
      expect(formatted.startsWith('Workspace Test workspace\n\n')).toBe(true);
      expect(formatted.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe('Telegram update read state', () => {
  it('removes Reply after continuing, preserves Dismiss, and prevents stale edits or taps restoring it', async () => {
    await paired();
    const id = notify();
    const event = await postedEvent(id);
    const row = api.store.get('SELECT id FROM telegram_outbox WHERE event_id=?', String(event.id))!;
    api.telegram.jobs.delivered(String(row.id), 900778);
    tap(String(event.id), 'read');
    await vi.waitFor(() => expect(api.notifications.list('default').unread).toBe(0));
    tap(String(event.id), 'continue');
    await vi.waitFor(() =>
      expect(
        api.store.get('SELECT continued FROM telegram_events WHERE id=?', String(event.id))
          ?.continued,
      ).toBe(1),
    );
    await vi.waitFor(
      () =>
        expect(
          api.store.get(
            'SELECT markup_json FROM telegram_outbox WHERE id=?',
            'continued:' + row.id,
          ),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    const markup = String(
      api.store.get('SELECT markup_json FROM telegram_outbox WHERE id=?', 'continued:' + row.id)!
        .markup_json,
    );
    expect(markup).toContain(':dismiss');
    expect(markup).not.toContain(':continue');
    expect(markup).not.toContain(':read');
    const staleReadEdit = {
      id: 'read:' + row.id,
      connectionId: api.telegram.connection()!.id,
      chatId: OWNER,
      text: ' ',
      attempts: 0,
      workspaceId: 'default',
      botId: 'scout',
      workspaceEvent: true,
      eventId: String(event.id),
      editMessageId: 900778,
      markup: { inline_keyboard: [[{ text: 'Reply', callback_data: `t:${event.id}:continue` }]] },
    };
    expect(api.telegram.deliveryAllowed(staleReadEdit)).toBe(true);
    expect(JSON.stringify(staleReadEdit.markup)).not.toContain(':continue');
    expect(JSON.stringify(staleReadEdit.markup)).toContain(':dismiss');
    const resume = vi.spyOn(api.notifications, 'continue');
    tap(String(event.id), 'continue');
    await vi.waitFor(() => expect(api.telegram.jobs.inbox()).toHaveLength(0));
    expect(resume).not.toHaveBeenCalled();
    tap(String(event.id), 'dismiss');
    await vi.waitFor(() => expect(api.notifications.list('default').total).toBe(0));
    expect(api.telegram.deliveryAllowed(staleReadEdit)).toBe(true);
    expect(staleReadEdit.markup).toEqual({ inline_keyboard: [] });
  }, 15000);
  it('keeps reply and dismiss available after marking an update read', async () => {
    await paired();
    const id = notify();
    const event = await postedEvent(id);
    const row = api.store.get('SELECT id FROM telegram_outbox WHERE event_id=?', String(event.id))!;
    api.telegram.jobs.delivered(String(row.id), 900777);
    tap(String(event.id), 'read');
    await vi.waitFor(() => expect(api.notifications.list('default').unread).toBe(0));
    expect(api.notifications.list('default').total).toBe(1);
    await vi.waitFor(
      () =>
        expect(
          api.store.get('SELECT markup_json FROM telegram_outbox WHERE id=?', 'read:' + row.id),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    const markup = String(
      api.store.get('SELECT markup_json FROM telegram_outbox WHERE id=?', 'read:' + row.id)!
        .markup_json,
    );
    expect(markup).toContain(':continue');
    expect(markup).toContain(':dismiss');
    expect(markup).not.toContain(':read');
    tap(String(event.id), 'dismiss');
    await vi.waitFor(() => expect(api.notifications.list('default').total).toBe(0));
  }, 15000);
});

describe('Telegram delivery scheduling', () => {
  it('sends direct replies ahead of an update backlog', async () => {
    await paired();
    const id = notify();
    await postedEvent(id);
    api.store.run("UPDATE telegram_outbox SET state='sent' WHERE event_id IS NULL");
    api.telegram.jobs.queue(
      {
        connectionId: api.telegram.connection()!.id,
        chatId: OWNER,
        workspaceId: 'default',
        botId: 'scout',
        text: 'A direct reply.',
      },
      'direct-priority',
    );
    expect(api.telegram.jobs.delivery(Date.now())!.id).toBe('direct-priority');
    expect(api.telegram.jobs.delivery(Date.now())!.text).toBe('A direct reply.');
    api.telegram.jobs.delivered('direct-priority', 456);
    api.telegram.jobs.queue(
      {
        connectionId: api.telegram.connection()!.id,
        chatId: OWNER,
        workspaceId: 'default',
        botId: 'scout',
        workspaceEvent: true,
        text: ' ',
        editMessageId: 123,
        markup: { inline_keyboard: [] },
      },
      'button-update',
    );
    expect(api.telegram.jobs.delivery(Date.now())!.id).toBe('button-update');
  });
});
