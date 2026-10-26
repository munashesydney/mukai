import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ChatActivity } from '../../../shared/ai';
import { wavFixture, mp3Fixture, mp4Fixture } from '../../testMediaFixtures';
import { executeMedia, mediaTools } from './execute';
import { mediaDefinition } from './definition';
import { computerTools } from '../../computer/tools';
import { GuestDispatcher } from '../../computer/guestDispatcher';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mukai-media-tool-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const owner = { botId: 'bot', workspaceId: 'workspace', conversationId: 'chat' };
const options = { toolCallId: 'media-call', messages: [], context: {} };
function context(enabled = true) {
  const activities: ChatActivity[] = [];
  return {
    owner,
    folder: dir,
    vision: enabled,
    supportsAudio: enabled,
    supportsVideo: enabled,
    signal: new AbortController().signal,
    budget: { remaining: 10 },
    onActivity: (activity: ChatActivity) => activities.push(activity),
    activities,
  };
}

it.each([
  ['audio', 'wav', wavFixture(), 'audio/wav'],
  ['audio', 'mp3', mp3Fixture(), 'audio/mpeg'],
  ['video', 'mp4', mp4Fixture(), 'video/mp4'],
  ['video', 'mov', mp4Fixture(), 'video/quicktime'],
] as const)(
  'reads %s %s metadata without delivering content, then inspects original bytes',
  async (kind, extension, bytes, mediaType) => {
    const path = join(dir, 'sample.' + extension);
    await writeFile(path, bytes);
    const metadata = await executeMedia(
      { action: kind === 'audio' ? 'read_audio' : 'read_video', path },
      context(false),
      'read',
    );
    expect(metadata).toMatchObject({
      ok: true,
      result: {
        kind,
        mediaType,
        bytes: bytes.length,
        inspected: false,
        mediaDelivery: 'metadata_only',
      },
    });
    expect(JSON.stringify(metadata)).not.toContain(bytes.toString('base64'));
    const ctx = context(),
      tools = mediaTools(ctx);
    const output = await tools.media.execute!(
      { action: kind === 'audio' ? 'listen_audio' : 'view_video', path },
      options,
    );
    const converted = await tools.media.toModelOutput!({
      input: {},
      output,
      toolCallId: 'media-call',
    });
    expect(converted).toMatchObject({
      type: 'content',
      value: [
        { type: 'text', text: expect.stringContaining('"mediaDelivery":"included"') },
        { type: 'file', mediaType, data: { type: 'data', data: bytes.toString('base64') } },
      ],
    });
    expect(JSON.stringify(ctx.activities)).not.toContain(bytes.toString('base64'));
  },
);
it('uses saved IDs without a workspace and keeps image previews and references working', async () => {
  const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#369' } })
    .png()
    .toBuffer();
  const readMedia = vi.fn(async ({ attachmentId }: { attachmentId?: string }) => ({
    bytes: attachmentId ? wavFixture() : png,
    name: attachmentId ? 'upload.wav' : 'render.png',
  }));
  const ctx = { ...context(), folder: null, readMedia };
  expect(
    await executeMedia({ action: 'listen_audio', attachmentId: 'upload' }, ctx, 'listen'),
  ).toMatchObject({
    ok: true,
    result: { attachmentId: 'upload', reference: 'mukai://attachment/upload' },
  });
  expect(
    await executeMedia({ action: 'view_image', artifactId: 'render' }, ctx, 'view'),
  ).toMatchObject({ ok: true, result: { viewed: true, width: 20, artifactId: 'render' } });
  expect(ctx.activities.at(-1)).toMatchObject({
    tool: 'media',
    action: 'view_image',
    artifactId: 'render',
  });
});
it('returns factual capability failures before reading bytes, and bounded missing/corrupt-file feedback', async () => {
  const readMedia = vi.fn();
  for (const action of ['listen_audio', 'view_video', 'view_image'] as const) {
    const result = await executeMedia(
      { action, attachmentId: 'upload' },
      { ...context(false), readMedia },
      action,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('input disabled') });
    expect(JSON.stringify(result)).not.toMatch(/tell the user|explain|choose|switch|do not claim/i);
  }
  expect(readMedia).not.toHaveBeenCalled();
  const missing = await executeMedia(
    { action: 'listen_audio', path: 'missing.wav' },
    context(),
    'missing',
  );
  expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('no longer exists') });
  await writeFile(join(dir, 'corrupt.wav'), 'not audio');
  expect(
    await executeMedia({ action: 'read_audio', path: 'corrupt.wav' }, context(), 'corrupt'),
  ).toMatchObject({ ok: false, error: expect.stringContaining('invalid') });
  await writeFile(join(dir, 'large.wav'), Buffer.alloc(10 * 1024 * 1024 + 1));
  expect(
    await executeMedia({ action: 'listen_audio', path: 'large.wav' }, context(), 'large'),
  ).toMatchObject({ ok: false, error: expect.stringContaining('10 MiB') });
  expect(
    mediaDefinition.inputSchema.safeParse({ action: 'read_audio', path: 'a', attachmentId: 'b' })
      .success,
  ).toBe(false);
  expect(
    mediaDefinition.inputSchema.safeParse({ action: 'listen_audio', path: 'a', detail: 'high' })
      .success,
  ).toBe(false);
});
it('reads guest paths, copies exact audio/video bytes to the guest, and resolves IDs on the host', async () => {
  const guest = new GuestDispatcher(dir, join(dir, 'private'));
  const ctx = context();
  const hostRead = vi.fn(async () => ({ bytes: wavFixture(), name: 'host.wav' }));
  const computer = { request: vi.fn(guest.request.bind(guest)) };
  const bytes = { audio: wavFixture(), video: mp4Fixture() };
  const tools = computerTools({
    ...ctx,
    computer,
    readImage: hostRead,
    attachmentBytes: async (id) => bytes[id as keyof typeof bytes],
    fileBudget: { remaining: 10 },
    recordChange: () => {},
    recordFile: () => {},
    saveScreenshot: async () => ({ artifactId: 'shot', path: 'shot.png', width: 1, height: 1 }),
  });
  try {
    for (const kind of ['audio', 'video'] as const) {
      const path = kind === 'audio' ? 'copy.wav' : 'copy.mp4';
      expect(
        await tools.file_operations.execute!(
          { action: 'copy_attachment', attachmentId: kind, path },
          options,
        ),
      ).toMatchObject({ ok: true });
      expect(await readFile(join(dir, path))).toEqual(bytes[kind]);
      const result = await tools.media.execute!(
        { action: kind === 'audio' ? 'listen_audio' : 'view_video', path },
        options,
      );
      expect(result).toMatchObject({ ok: true, result: { media: bytes[kind].toString('base64') } });
    }
    computer.request.mockClear();
    expect(
      await tools.media.execute!({ action: 'listen_audio', attachmentId: 'audio' }, options),
    ).toMatchObject({ ok: true });
    expect(computer.request).not.toHaveBeenCalled();
    expect(hostRead).toHaveBeenCalled();
    const blocked = computerTools({
      ...ctx,
      computer,
      supportsAudio: false,
      fileBudget: { remaining: 1 },
      recordChange: () => {},
      recordFile: () => {},
      saveScreenshot: vi.fn(),
    });
    expect(
      await blocked.media.execute!({ action: 'listen_audio', path: 'copy.wav' }, options),
    ).toMatchObject({ ok: false, error: expect.stringContaining('input disabled') });
    expect(computer.request).not.toHaveBeenCalled();
  } finally {
    await guest.shutdown();
  }
});
