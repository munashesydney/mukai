import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { executeImage, imageTools } from './execute';
import type { ChatActivity } from '../../../shared/ai';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mukai-image-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
function context(vision = true, folder: string | null = dir) {
  const activities: ChatActivity[] = [];
  return {
    owner: { botId: 'bot', workspaceId: 'workspace', conversationId: 'chat' },
    signal: new AbortController().signal,
    budget: { remaining: 10 },
    onActivity: (activity: ChatActivity) => {
      activities.push(activity);
    },
    vision,
    folder,
    activities,
  };
}
async function fixture(format: 'png' | 'jpeg' | 'webp', width = 30, height = 20) {
  const path = join(dir, 'picture.' + format);
  const image = sharp({ create: { width, height, channels: 3, background: '#0088cc' } });
  await image[format]().toFile(path);
  return path;
}
describe('local image tools', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'decodes %s by contents and returns metadata without image data for read',
    async (format) => {
      const path = await fixture(format);
      const result = await executeImage({ action: 'read', path }, context(false, null), 'read');
      expect(result).toMatchObject({
        ok: true,
        result: { path, width: 30, height: 20, format, viewed: false },
      });
      expect(JSON.stringify(result)).not.toContain('"image":');
    },
  );
  it('views outside-workspace absolute paths, resolves relative paths, scales high and preserves original', async () => {
    const path = await fixture('png', 3000, 1500);
    const ctx = context(true, join(dir, 'different-workspace'));
    const high = await executeImage({ action: 'view', path }, ctx, 'high');
    expect(high).toMatchObject({ ok: true, result: { outputWidth: 2048, outputHeight: 1024 } });
    const original = await executeImage(
      { action: 'view', path: 'picture.png', detail: 'original' },
      context(),
      'original',
    );
    expect(original).toMatchObject({ ok: true, result: { outputWidth: 3000, outputHeight: 1500 } });
    expect(JSON.stringify(ctx.activities)).not.toContain('iVBOR');
  });
  it('rejects corrupt, oversized, missing, non-file and non-vision view inputs', async () => {
    await writeFile(join(dir, 'fake.png'), 'not an image');
    await writeFile(join(dir, 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    for (const path of ['fake.png', 'big.png', 'missing.png', dir])
      expect(await executeImage({ action: 'view', path }, context(), path)).toMatchObject({
        ok: false,
      });
    expect(
      await executeImage({ action: 'view', path: await fixture('png') }, context(false), 'text'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('vision model') });
    expect(
      await executeImage({ action: 'read', path: 'picture.png' }, context(true, null), 'relative'),
    ).toMatchObject({ ok: false, error: expect.stringContaining('absolute path') });
  });
  it('emits image content rather than base64 JSON and preserves rejection results', async () => {
    const ctx = context();
    const tools = imageTools(ctx);
    const output = await executeImage({ action: 'view', path: await fixture('png') }, ctx, 'view');
    const converted = await tools.image.toModelOutput!({ toolCallId: 'view', input: {}, output });
    expect(converted).toMatchObject({
      type: 'content',
      value: [
        { type: 'text' },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'data', data: expect.stringMatching(/^iVBOR/) },
        },
      ],
    });
    if (converted.type === 'content')
      expect(JSON.stringify(converted.value[0])).not.toContain('iVBOR');
    expect(
      await tools.image.toModelOutput!({
        toolCallId: 'deny',
        input: {},
        output: { rejected: true },
      }),
    ).toMatchObject({ type: 'text', value: expect.stringContaining('rejected') });
  });
});
