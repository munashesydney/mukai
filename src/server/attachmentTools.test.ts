import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { AttachmentRepository } from './repositories/attachmentRepository';
import { ArtifactRepository } from './repositories/artifactRepository';
import { BotRepository } from './repositories/botRepository';
import { scoutBot } from './services/botService';
import { WorkspaceFileService } from './services/workspaceFileService';
import { ArtifactService } from './services/artifactService';
import { executeFileOperations } from './tools/file-operations/execute';
import { conversationsDefinition } from './tools/conversations/definition';
import { conversationTools } from './tools/conversations/execute';
import { imageTools } from './tools/image/execute';
import { imageDefinition } from './tools/image/definition';
import { computerTools } from './computer/tools';
import { GuestDispatcher } from './computer/guestDispatcher';
import type { ChatActivity } from '../shared/ai';

let api: ReturnType<typeof createApiServer>, dir: string, folder: string, png: Buffer;
let artifactService: ArtifactService;
const signal = () => new AbortController().signal;
const owner = { workspaceId: 'default', botId: 'scout', conversationId: 'bot-scout' };
const options = (toolCallId: string) => ({ toolCallId, messages: [], context: {} });
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mukai-attachment-tools-')));
  folder = join(dir, 'workspace');
  await mkdir(folder);
  api = createApiServer({
    dataDir: join(dir, 'private'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestBot(api.store);
  api.store.run('UPDATE workspaces SET folder=? WHERE id=?', folder, 'default');
  artifactService = new ArtifactService(
    new ArtifactRepository(api.store),
    new BotRepository(api.store),
    api.workspaces,
    join(dir, 'private'),
  );
  png = await sharp({ create: { width: 25, height: 15, channels: 3, background: '#0088cc' } })
    .png()
    .toBuffer();
});
afterEach(async () => {
  await api.shutdown();
  api.dispose();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
async function upload(name: string, bytes: Buffer, workspaceId = 'default', pending = false) {
  const botId = workspaceId === 'default' ? 'scout' : 'other';
  const messageId = randomUUID(),
    id = randomUUID();
  if (!pending)
    api.store.run(
      `INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at)
    VALUES(?,?,?,?,'user','','complete',?)`,
      messageId,
      botId,
      'bot-' + botId,
      randomUUID(),
      '2026-10-15T12:00:00Z',
    );
  const image = name.endsWith('.png');
  new AttachmentRepository(api.store).create({
    id,
    botId,
    conversationId: 'bot-' + botId,
    messageId: pending ? null : messageId,
    name,
    mediaType: image ? 'image/png' : 'text/plain',
    kind: image ? 'image' : 'text',
    size: bytes.length,
    storageName: id,
    extractedText: image ? null : bytes.toString(),
    warning: null,
  });
  await writeFile(join(dir, 'private', 'uploads', id), bytes);
  return id;
}
function conversations() {
  return conversationTools({
    history: api.conversationHistory,
    artifacts: api.conversationArtifacts,
    workspaceId: 'default',
    signal: signal(),
    onActivity: () => {},
  }).conversations;
}
async function query(input: object) {
  const result = await conversations().execute!(
    conversationsDefinition.inputSchema.parse(input),
    options('query'),
  );
  if (!result || !('results' in result)) throw new Error('Expected a result page.');
  return result;
}
function imageContext() {
  const activities: ChatActivity[] = [];
  return {
    owner,
    signal: signal(),
    budget: { remaining: 10 },
    folder,
    vision: true,
    onActivity: (activity: ChatActivity) => activities.push(activity),
    activities,
    readImage: async (input: { attachmentId?: string; artifactId?: string }) => {
      const result = await api.conversationArtifacts.bytes('default', input);
      return { bytes: result.bytes, name: result.metadata.name };
    },
  };
}
describe('Saved uploads and artifact tools', () => {
  it('filters artifact kinds separately from conversation types and normalizes text uploads to files', async () => {
    const image = await upload('reference.png', png);
    const text = await upload('notes.txt', Buffer.from('Notes'));
    const messageId = api.conversationArtifacts.metadata('default', {
      attachmentId: image,
    }).messageId;
    await writeFile(join(folder, 'copied.png'), png);
    const repository = new ArtifactRepository(api.store);
    repository.save({
      id: 'copied',
      botId: 'scout',
      messageId,
      name: 'copied.png',
      path: 'copied.png',
      createdAt: '2026-10-16T00:00:00Z',
    });
    // Explicit metadata overrides filename guesses (a text file can be named .png).
    repository.save({
      id: 'text-png',
      botId: 'scout',
      messageId,
      name: 'text.png',
      path: 'text.png',
      mediaType: 'text/plain',
      size: 4,
      createdAt: '2026-10-16T01:00:00Z',
    });
    const images = await query({
      action: 'list_artifacts',
      artifactKind: 'image',
      kind: 'private',
      limit: 1,
    });
    expect(images.results).toMatchObject([
      {
        id: 'copied',
        kind: 'image',
        mediaType: 'image/png',
        size: png.length,
        location: 'workspace',
        computer: 'local',
        metadataStatus: 'recorded',
      },
    ]);
    expect(images.nextOffset).toBe(1);
    expect(
      (await query({ action: 'list_artifacts', artifactKind: 'image', offset: 1 })).results,
    ).toMatchObject([{ id: image, kind: 'image' }]);
    const files = await query({
      action: 'search_artifacts',
      artifactKind: 'file',
      query: '.',
      kind: 'private',
    });
    expect(files.results.map((item) => item.id)).toEqual(['text-png', text]);
    expect(files.results[1]).toMatchObject({
      kind: 'file',
      location: 'upload-storage',
      path: null,
      computer: null,
    });
    expect(
      (await query({ action: 'list_artifacts', artifactKind: 'image', kind: 'bot' })).results,
    ).toEqual([]);
    expect(
      (await query({ action: 'list_artifacts', artifactKind: 'file', offset: 9999 })).nextOffset,
    ).toBeNull();
    for (const input of [
      { action: 'search', artifactKind: 'image' },
      { action: 'read_artifact', attachmentId: image, artifactKind: 'image' },
    ])
      expect(conversationsDefinition.inputSchema.safeParse(input).success).toBe(false);
    expect(repository.find('copied')).toMatchObject({
      size: png.length,
      mediaType: 'image/png',
      createdAt: '2026-10-16T00:00:00Z',
    });
  });
  it('hides managed storage paths in VM discovery while retaining ID access and accurate metadata', async () => {
    const image = await upload('reference.png', png);
    const messageId = api.conversationArtifacts.metadata('default', {
      attachmentId: image,
    }).messageId;
    api.store.run("UPDATE workspaces SET computer='qemu' WHERE id='default'");
    const guest = vi.spyOn(api.computers, 'guest');
    const saved = await artifactService.recordScreenshot(
      'scout',
      messageId,
      png.toString('base64'),
      signal(),
    );
    // Exercise enrichment for an older screenshot, including a zero-byte file size later.
    api.store.run('UPDATE artifacts SET size=NULL WHERE id=?', saved.artifactId);
    const found = await query({
      action: 'list_artifacts',
      source: 'artifact',
      artifactKind: 'image',
    });
    expect(found.results).toMatchObject([
      {
        id: saved.artifactId,
        path: null,
        location: 'managed-storage',
        computer: null,
        kind: 'image',
        mediaType: 'image/png',
        size: png.length,
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(dir);
    expect(
      (await query({ action: 'search_artifacts', query: dir, source: 'artifact' })).results,
    ).toEqual([]);
    expect(
      (await api.conversationArtifacts.bytes('default', { artifactId: saved.artifactId })).bytes,
    ).toEqual(png);
    new ArtifactRepository(api.store).save({
      id: 'offline',
      botId: 'scout',
      messageId,
      path: 'guest.txt',
      name: 'guest.txt',
      createdAt: '2026-10-16T01:00:00Z',
    });
    expect(
      (await query({ action: 'list_artifacts', source: 'artifact', artifactKind: 'file' })).results,
    ).toMatchObject([
      {
        id: 'offline',
        path: 'guest.txt',
        computer: 'qemu',
        size: null,
        metadataStatus: 'unavailable',
      },
    ]);
    expect(guest).not.toHaveBeenCalled();
  });
  it('enriches available legacy files in a running guest without transferring their full contents', async () => {
    const image = await upload('reference.png', png);
    const messageId = api.conversationArtifacts.metadata('default', {
      attachmentId: image,
    }).messageId;
    api.store.run("UPDATE workspaces SET computer='qemu' WHERE id='default'");
    new ArtifactRepository(api.store).save({
      id: 'guest-image',
      botId: 'scout',
      messageId,
      path: 'render.png',
      name: 'render.png',
      createdAt: '2026-10-16T00:00:00Z',
    });
    const request = vi.fn().mockResolvedValue({ mediaType: 'image/png', size: png.length });
    vi.spyOn(api.computers, 'status').mockReturnValue({ kind: 'qemu', state: 'running' });
    vi.spyOn(api.computers, 'guest').mockReturnValue({ request } as unknown as ReturnType<
      typeof api.computers.guest
    >);
    const found = await query({
      action: 'search_artifacts',
      query: 'render',
      artifactKind: 'image',
    });
    expect(found.results).toMatchObject([
      { path: 'render.png', computer: 'qemu', mediaType: 'image/png', size: png.length },
    ]);
    expect(request).toHaveBeenCalledWith(
      'files',
      { action: 'inspect_artifact', path: 'render.png' },
      expect.any(Object),
      expect.any(AbortSignal),
    );
    await query({ action: 'list_artifacts' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('returns structured guidance for unreadable bytes and invalid text offsets, but still throws unexpected failures', async () => {
    const text = await upload('notes.txt', Buffer.from('Notes'));
    expect(
      await query({ action: 'read_artifact', attachmentId: text, contentOffset: 100 }),
    ).toMatchObject({ ok: false, feedback: { code: 'invalid_content_offset' } });
    const messageId = api.conversationArtifacts.metadata('default', {
      attachmentId: text,
    }).messageId;
    new ArtifactRepository(api.store).save({
      id: 'binary',
      botId: 'scout',
      messageId,
      path: 'data.bin',
      name: 'data.bin',
      createdAt: '2026-10-16T00:00:00Z',
    });
    await writeFile(join(folder, 'data.bin'), Buffer.from([0, 1, 255]));
    expect(await query({ action: 'read_artifact', artifactId: 'binary' })).toMatchObject({
      ok: false,
      feedback: { code: 'not_readable_text' },
    });
    vi.spyOn(ArtifactService.prototype, 'read').mockRejectedValue(
      new Error('Unexpected disk failure'),
    );
    await expect(query({ action: 'read_artifact', artifactId: 'binary' })).rejects.toThrow(
      'Unexpected disk failure',
    );
  });
  it('reopens a copied generated image larger than the text-file limit by artifact ID', async () => {
    const bytes = await sharp(randomBytes(600 * 600 * 3), {
      raw: { width: 600, height: 600, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(256 * 1024);
    const id = await upload('large.png', bytes);
    const files = new WorkspaceFileService(folder, join(dir, 'private'));
    await files.copyAttachment('large-copy.png', bytes, false, signal());
    const messageId = api.conversationArtifacts.metadata('default', { attachmentId: id }).messageId;
    new ArtifactRepository(api.store).save({
      id: 'large-copy',
      botId: 'scout',
      messageId,
      path: 'large-copy.png',
      name: 'large-copy.png',
      createdAt: new Date().toISOString(),
    });
    const tools = imageTools(imageContext());
    const result = await tools.image.execute!(
      { action: 'view', artifactId: 'large-copy' },
      options('large-view'),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { artifactId: 'large-copy', width: 600, height: 600 },
    });
    expect(
      (await api.conversationArtifacts.bytes('default', { artifactId: 'large-copy' })).bytes,
    ).toEqual(bytes);
  });
  it('keeps extracted document text separate from the original copyable bytes', async () => {
    const original = Buffer.from('original document bytes');
    const id = await upload('report.pdf', original);
    api.store.run(
      'UPDATE attachments SET extracted_text=?,warning=? WHERE id=?',
      'Extracted page text',
      'Only the first 20 pages are extracted.',
      id,
    );
    const result = await query({ action: 'read_artifact', attachmentId: id });
    expect(result.results[0]).toMatchObject({
      content: 'Extracted page text',
      warning: expect.stringContaining('20 pages'),
    });
    expect((await api.conversationArtifacts.bytes('default', { attachmentId: id })).bytes).toEqual(
      original,
    );
  });
  it('discovers sent uploads and generated files with stable pagination, literal search and workspace filters', async () => {
    const a = await upload('reference.png', png),
      b = await upload('notes_100%.txt', Buffer.from('Useful notes'));
    const pending = await upload('unsent.png', png, 'default', true);
    api.store.run(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('other','Other',NULL,'now')",
    );
    new BotRepository(api.store).create(scoutBot('other', 'other'));
    const foreign = await upload('secret.png', png, 'other');
    const messageId = String(
      api.store.get('SELECT message_id FROM attachments WHERE id=?', a)!.message_id,
    );
    new ArtifactRepository(api.store).save({
      id: 'generated',
      botId: 'scout',
      messageId,
      name: 'draft.md',
      path: 'draft.md',
      createdAt: '2026-10-15T13:00:00Z',
    });
    await writeFile(join(folder, 'draft.md'), '# Draft');
    const ids: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await query({ action: 'list_artifacts', limit: 1, offset });
      expect(page.results).toHaveLength(1);
      ids.push(String(page.results[0].id));
      expect(page.nextOffset).toBe(offset < 2 ? offset + 1 : null);
    }
    expect(new Set(ids)).toEqual(new Set([a, b, 'generated']));
    expect(ids).not.toContain(pending);
    expect(ids).not.toContain(foreign);
    const search = await query({
      action: 'search_artifacts',
      query: '_100%',
      source: 'attachment',
      conversationId: 'bot-scout',
    });
    expect(search.results).toMatchObject([
      { id: b, source: 'attachment', name: 'notes_100%.txt', path: null },
    ]);
    expect(JSON.stringify(search)).not.toContain('storageName');
    await expect(query({ action: 'list_artifacts', conversationId: 'bot-other' })).rejects.toThrow(
      'workspace',
    );
    await expect(
      api.conversationArtifacts.bytes('default', { attachmentId: foreign }),
    ).rejects.toThrow('workspace');
    await expect(
      api.conversationArtifacts.bytes('default', { attachmentId: pending }),
    ).rejects.toThrow('workspace');
    const read = await query({ action: 'read_artifact', artifactId: 'generated' });
    expect(read.results).toMatchObject([{ content: '# Draft', source: 'artifact' }]);
    const text = await upload('long.txt', Buffer.from('a'.repeat(17000)));
    const first = await query({ action: 'read_artifact', attachmentId: text });
    expect(first.results[0]).toMatchObject({
      contentOffset: 0,
      nextContentOffset: 12000,
      truncated: true,
    });
    const next = await query({ action: 'read_artifact', attachmentId: text, contentOffset: 12000 });
    expect(next.results[0]).toMatchObject({ nextContentOffset: null, truncated: false });
  });
  it('reopens image pixels by ID without a workspace copy and keeps references in activity', async () => {
    const id = await upload('reference.png', png);
    const context = imageContext(),
      tools = imageTools(context);
    const output = await tools.image.execute!(
      { action: 'view', attachmentId: id },
      options('view'),
    );
    expect(output).toMatchObject({
      ok: true,
      result: { attachmentId: id, name: 'reference.png', width: 25, height: 15 },
    });
    const model = await tools.image.toModelOutput!({ toolCallId: 'view', input: {}, output });
    expect(model).toMatchObject({
      type: 'content',
      value: [{ type: 'text' }, { type: 'file', mediaType: 'image/png' }],
    });
    expect(context.activities.at(-1)).toMatchObject({
      attachmentId: id,
      path: 'reference.png',
      status: 'complete',
    });
    expect(JSON.stringify(context.activities)).not.toContain('iVBOR');
    expect(
      imageDefinition.inputSchema.safeParse({ action: 'view', path: 'a.png', attachmentId: id })
        .success,
    ).toBe(false);
    expect(imageDefinition.inputSchema.safeParse({ action: 'view' }).success).toBe(false);
    const denied = await imageTools({ ...context, vision: false }).image.execute!(
      { action: 'view', attachmentId: id },
      options('text'),
    );
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining('vision') });
    expect(await query({ action: 'read_artifact', attachmentId: id })).toMatchObject({
      ok: false,
      results: [],
      nextOffset: null,
      feedback: {
        code: 'image_requires_view',
        message: expect.stringContaining('image.view'),
        nextAction: { tool: 'image', input: { action: 'view', attachmentId: id } },
      },
    });
  });
  it('copies original binary bytes to relative or absolute local destinations and requires explicit overwrite', async () => {
    const id = await upload('reference.png', png);
    const files = new WorkspaceFileService(folder, join(dir, 'private'));
    const record = vi.fn();
    const context = {
      botId: 'scout',
      signal: signal(),
      files,
      callBudget: { remaining: 10 },
      onActivity: () => {},
      onFileChanged: record,
      attachmentBytes: async (attachmentId: string) =>
        (await api.conversationArtifacts.bytes('default', { attachmentId })).bytes,
    };
    expect(
      await executeFileOperations(
        { action: 'copy_attachment', attachmentId: id, path: 'copy.png' },
        context,
        'copy',
      ),
    ).toMatchObject({ ok: true, path: join(folder, 'copy.png') });
    expect(await readFile(join(folder, 'copy.png'))).toEqual(png);
    expect(record).toHaveBeenCalledWith('copy.png', { mediaType: 'image/png', size: png.length });
    await writeFile(join(folder, 'copy.png'), 'keep me');
    expect(
      await executeFileOperations(
        { action: 'copy_attachment', attachmentId: id, path: 'copy.png' },
        context,
        'exists',
      ),
    ).toMatchObject({ ok: false });
    expect((await readFile(join(folder, 'copy.png'))).toString()).toBe('keep me');
    expect(
      await executeFileOperations(
        { action: 'copy_attachment', attachmentId: id, path: 'copy.png', overwrite: true },
        context,
        'replace',
      ),
    ).toMatchObject({ ok: true });
    const outside = join(dir, 'outside.png');
    expect(
      await executeFileOperations(
        { action: 'copy_attachment', attachmentId: id, path: outside },
        context,
        'absolute',
      ),
    ).toMatchObject({ ok: true, path: outside });
    expect(await readFile(outside)).toEqual(png);
    await expect(
      files.copyAttachment(join(dir, 'private', 'bad.png'), png, false, signal()),
    ).rejects.toThrow('private');
    await expect(files.copyAttachment('../escape.png', png, false, signal())).rejects.toThrow(
      'outside',
    );
    await expect(files.copyAttachment('.git/config', png, true, signal())).rejects.toThrow(
      'protected',
    );
  });
  it('copies into the guest and reopens uploaded images without sending host paths to the guest', async () => {
    const id = await upload('reference.png', png);
    const guestFolder = join(dir, 'guest-workspace'),
      guestData = join(dir, 'guest-private');
    await mkdir(guestFolder);
    await mkdir(guestData);
    const computer = new GuestDispatcher(guestFolder, guestData);
    const request = vi.spyOn(computer, 'request');
    const recordFile = vi.fn();
    const context = imageContext();
    const tools = computerTools({
      ...context,
      computer,
      fileBudget: { remaining: 10 },
      recordChange: () => {},
      recordFile,
      saveScreenshot: async () => ({ artifactId: '', path: '', width: 1, height: 1 }),
      attachmentBytes: async (attachmentId) =>
        (await api.conversationArtifacts.bytes('default', { attachmentId })).bytes,
    });
    try {
      const copied = await tools.file_operations.execute!(
        { action: 'copy_attachment', attachmentId: id, path: 'guest-copy.png' },
        options('copy'),
      );
      expect(copied).toMatchObject({
        ok: true,
        result: { path: join(guestFolder, 'guest-copy.png') },
      });
      expect(await readFile(join(guestFolder, 'guest-copy.png'))).toEqual(png);
      expect(recordFile).toHaveBeenCalledWith('guest-copy.png', {
        mediaType: 'image/png',
        size: png.length,
      });
      expect(
        await computer.request(
          'files',
          { action: 'inspect_artifact', path: 'guest-copy.png' },
          owner,
          signal(),
        ),
      ).toEqual({ mediaType: 'image/png', size: png.length });
      await expect(readFile(join(folder, 'guest-copy.png'))).rejects.toThrow();
      const wire = request.mock.calls[0][1];
      expect(wire).toMatchObject({
        action: 'copy_attachment',
        path: 'guest-copy.png',
        bytes: png.toString('base64'),
      });
      request.mockClear();
      const viewed = await tools.image.execute!(
        { action: 'view', attachmentId: id },
        options('view'),
      );
      expect(viewed).toMatchObject({ ok: true, result: { width: 25, height: 15 } });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await computer.shutdown();
    }
  });
});
