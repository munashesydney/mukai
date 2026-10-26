import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { ArtifactRepository } from '../repositories/artifactRepository';
import { AttachmentRepository } from '../repositories/attachmentRepository';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import { BotRepository } from '../repositories/botRepository';
import { scoutBot } from '../services/botService';
import { TelegramClient } from './client';
import { TelegramDeliveryQueue } from './delivery';
import type { ChatMessage } from '../../shared/ai';
import type { TelegramJob } from './types';

let dir: string, folder: string, api: ReturnType<typeof createApiServer>, job: TelegramJob;
const signal = () => new AbortController().signal;
const dataDir = () => join(dir, 'private');

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mukai-telegram-media-')));
  folder = join(dir, 'workspace');
  await mkdir(folder);
  api = createApiServer({ dataDir: dataDir(), memoryExtractor: async () => ({ facts: [] }) });
  seedTestBot(api.store);
  api.store.run("UPDATE workspaces SET folder=? WHERE id='default'", folder);
  api.telegram.attachRuntime({ start() {}, async stop() {} });
  vi.spyOn(TelegramClient.prototype, 'identity').mockResolvedValue({
    id: 12345,
    is_bot: true,
    username: 'MukaiTestBot',
    first_name: 'Mukai',
  });
  vi.spyOn(TelegramClient.prototype, 'call').mockResolvedValue({ url: '' });
  await api.telegram.connect('12345:telegram_media_test_token');
  api.telegram.pairing();
  api.telegram.connections.claim({ id: 42, firstName: 'Owner' });
  api.telegram.approve(42);
  await api.telegram.setAccess({ workspaces: [{ workspaceId: 'default', botId: null }] });
  const session = api.telegram.sessions.select(
    api.telegram.connection()!.id,
    42,
    'default',
    'scout',
  );
  api.telegram.jobs.enqueue(session, 'Make files', 99, 'media-job');
  job = api.telegram.jobs.jobs('queued')[0];
  api.telegram.jobs.state(job.id, 'running');
  api.store.run("UPDATE telegram_outbox SET state='sent'");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.shutdown();
  api.dispose();
  expect(dir.startsWith(await realpath(tmpdir()))).toBe(true);
  await rm(dir, { recursive: true, force: true });
});
function answer(content: string, status: ChatMessage['status'] = 'complete'): ChatMessage {
  return {
    id: 'assistant',
    requestId: job.id,
    botId: job.botId,
    role: 'assistant',
    content,
    status,
    error: null,
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}
function recordMessage(id = 'assistant', botId = job.botId, conversationId = job.conversationId) {
  api.store.run(
    `INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at)
     VALUES(?,?,?,?,'assistant','','complete',?)`,
    id,
    botId,
    conversationId,
    'request-' + id,
    new Date().toISOString(),
  );
}
function mediaRows() {
  return api.store.all(
    'SELECT * FROM telegram_outbox WHERE media_json IS NOT NULL ORDER BY sequence',
  );
}

describe('Durable Telegram media delivery', () => {
  it('queues the final answer before deduplicated media, and survives reopening the database', async () => {
    const response = answer('![Screenshot](shot.png) [Again](shot.png#L2) [Report](report.pdf)');
    response.parts = [
      { id: 'reasoning', type: 'reasoning', text: '[Private](private.txt)' },
      { id: 'final', type: 'text', text: response.content },
    ];
    api.telegram.finish(job, response);
    expect(mediaRows()).toHaveLength(2);
    const rows = api.store.all(
      "SELECT id,text,media_json FROM telegram_outbox WHERE state='pending' ORDER BY sequence",
    );
    expect(rows.map((row) => row.id)).toEqual([
      'media-job:0',
      'media-job:media:0',
      'media-job:media:1',
    ]);
    expect(rows[0].media_json).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('private.txt');
    // Recovery or repeated completion cannot insert the same answer or attachments twice.
    api.telegram.finish(job, response);
    expect(mediaRows()).toHaveLength(2);
    await api.shutdown();
    api.dispose();
    api = createApiServer({ dataDir: dataDir(), memoryExtractor: async () => ({ facts: [] }) });
    api.telegram.jobs.delivered('media-job:0', 10);
    const delivery = api.telegram.jobs.delivery(Date.now())!;
    expect(delivery.media).toEqual({ href: 'shot.png', label: 'Screenshot' });
    expect(delivery.replyTo).toBe(99);
    api.telegram.jobs.sending(delivery.id);
    api.telegram.jobs.recoverDelivery();
    expect(api.store.get('SELECT state FROM telegram_outbox WHERE id=?', delivery.id)?.state).toBe(
      'uncertain',
    );
    expect(api.telegram.jobs.delivery(Date.now())!.media?.href).toBe('report.pdf');
  });

  it.each(['stopped', 'failed'] as const)(
    'does not attach unfinished work when a response is %s',
    (status) => {
      api.telegram.finish(job, answer('![Screenshot](shot.png)', status));
      expect(mediaRows()).toEqual([]);
    },
  );

  it('loads workspace paths, saved artifacts and sent attachments with the original media bytes', async () => {
    const bytes = Buffer.from('ID3original audio bytes');
    await writeFile(join(folder, 'song.mp3'), bytes);
    recordMessage();
    new ArtifactRepository(api.store).save({
      id: 'song',
      botId: 'scout',
      messageId: 'assistant',
      path: 'song.mp3',
      name: 'song.mp3',
      createdAt: new Date().toISOString(),
    });
    new AttachmentRepository(api.store).create({
      id: 'upload',
      botId: 'scout',
      conversationId: job.conversationId,
      messageId: 'assistant',
      name: 'recording.mp3',
      kind: 'audio',
      mediaType: 'audio/mpeg',
      size: bytes.length,
      storageName: 'upload',
      extractedText: null,
      warning: null,
    });
    await writeFile(join(dataDir(), 'uploads', 'upload'), bytes);
    api.telegram.finish(
      job,
      answer(
        '[Path](song.mp3) [Artifact](mukai://artifact/song) [Attachment](mukai://attachment/upload)',
      ),
    );
    api.telegram.jobs.delivered('media-job:0', 10);
    for (let index = 0; index < 3; index++) {
      const delivery = api.telegram.jobs.delivery(Date.now())!;
      const source = await api.telegram.loadMedia(delivery, signal());
      expect(source.bytes).toEqual(bytes);
      expect(source.mediaType).toBe('audio/mpeg');
      api.telegram.jobs.delivered(delivery.id, 11 + index);
    }
  });

  it('keeps preview limits unchanged while permitting larger local Telegram video uploads', async () => {
    const bytes = Buffer.alloc(11 * 1024 * 1024);
    bytes.write('ftypisom', 4);
    await writeFile(join(folder, 'clip.mp4'), bytes);
    api.telegram.finish(job, answer('[Video](clip.mp4)'));
    api.telegram.jobs.delivered('media-job:0', 10);
    const delivery = api.telegram.jobs.delivery(Date.now())!;
    await expect(
      api.conversationArtifacts.reference('default', 'clip.mp4', false, signal()),
    ).rejects.toThrow('file limit');
    const source = await api.telegram.loadMedia(delivery, signal());
    expect(source.mediaType).toBe('video/mp4');
    expect(source.bytes.equals(bytes)).toBe(true);
  });

  it('rejects private paths, outside files and artifacts from another workspace', async () => {
    await writeFile(join(dir, 'outside.txt'), 'private');
    await writeFile(join(folder, '.env'), 'private');
    new WorkspaceRepository(api.store).create({
      id: 'other',
      name: 'Other',
      folder: null,
      createdAt: new Date().toISOString(),
    });
    new BotRepository(api.store).create(scoutBot('other', 'other-bot'));
    recordMessage('other-message', 'other-bot', 'bot-other-bot');
    new ArtifactRepository(api.store).save({
      id: 'other-artifact',
      botId: 'other-bot',
      messageId: 'other-message',
      path: 'other.txt',
      name: 'other.txt',
      createdAt: new Date().toISOString(),
    });
    api.telegram.finish(
      job,
      answer('[Outside](../outside.txt) [Secret](.env) [Other](mukai://artifact/other-artifact)'),
    );
    api.telegram.jobs.delivered('media-job:0', 10);
    for (let index = 0; index < 3; index++) {
      const delivery = api.telegram.jobs.delivery(Date.now())!;
      await expect(api.telegram.loadMedia(delivery, signal())).rejects.toThrow();
      api.telegram.jobs.deliveryState(delivery.id, 'failed');
    }
  });

  it('cancels pending files after /stop or workspace access revocation', async () => {
    api.telegram.finish(job, answer('[Report](report.pdf)'));
    api.telegram.jobs.delivered('media-job:0', 10);
    const delivery = api.telegram.jobs.delivery(Date.now())!;
    expect(api.telegram.deliveryAllowed(delivery)).toBe(true);
    api.telegram.jobs.cancelConversation(job.conversationId);
    expect(api.telegram.deliveryAllowed(delivery)).toBe(false);
    expect(api.telegram.jobs.delivery(Date.now())).toBeUndefined();
    api.store.run("UPDATE telegram_outbox SET state='pending' WHERE media_json IS NOT NULL");
    await api.telegram.setAccess({ workspaces: [] });
    await expect(api.telegram.loadMedia(delivery, signal())).rejects.toThrow('access changed');
  });

  it('sends a workspace file through the real resolver and multipart Telegram transport', async () => {
    vi.restoreAllMocks();
    const bytes = Buffer.from('%PDF-1.7 original document');
    await writeFile(join(folder, 'report.pdf'), bytes);
    api.telegram.finish(job, answer('[Report](report.pdf)'));
    api.telegram.jobs.delivered('media-job:0', 10);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: { message_id: 222 } }));
    const queue = new TelegramDeliveryQueue(
      api.telegram,
      new TelegramClient('test-token', request),
    );
    try {
      queue.tick();
      await vi.waitFor(() =>
        expect(
          api.store.get("SELECT state FROM telegram_outbox WHERE id='media-job:media:0'")?.state,
        ).toBe('sent'),
      );
      expect(String(request.mock.calls[0][0])).toMatch(/\/sendDocument$/);
      const form = request.mock.calls[0][1]!.body as FormData;
      expect(Buffer.from(await (form.get('document') as Blob).arrayBuffer())).toEqual(bytes);
    } finally {
      await queue.stop();
    }
  });

  it('persists a user-facing notice after Telegram definitively rejects a file', async () => {
    vi.restoreAllMocks();
    await writeFile(join(folder, 'report.pdf'), '%PDF-1.7 original document');
    api.telegram.finish(job, answer('[Report](report.pdf)'));
    api.telegram.jobs.delivered('media-job:0', 10);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: false, error_code: 400 }, { status: 400 }));
    const queue = new TelegramDeliveryQueue(
      api.telegram,
      new TelegramClient('test-token', request),
    );
    try {
      queue.tick();
      await vi.waitFor(() =>
        expect(
          api.store.get("SELECT text FROM telegram_outbox WHERE id='media-job:media:0:notice'")
            ?.text,
        ).toContain('Could not deliver “Report”'),
      );
      expect(
        api.store.get("SELECT state FROM telegram_outbox WHERE id='media-job:media:0'")?.state,
      ).toBe('failed');
      expect(request).toHaveBeenCalledOnce();
    } finally {
      await queue.stop();
    }
  });
});
