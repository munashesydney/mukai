import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_DOWNLOAD_LIMIT } from '../../shared/artifacts';
import { downloadGuestFile } from './downloadFile';
import { GuestDispatcher } from './guestDispatcher';
import { encodeFrame, FRAME_LIMIT, type Computer } from './protocol';

let directory: string;
let folder: string;
let guest: GuestDispatcher;
const owner = { workspaceId: 'workspace', botId: 'bot', conversationId: 'conversation' };
const signal = () => new AbortController().signal;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-download-'));
  folder = join(directory, 'workspace');
  await mkdir(folder);
  guest = new GuestDispatcher(folder, join(directory, 'data'));
});
afterEach(async () => {
  await guest.shutdown();
  await rm(directory, { recursive: true, force: true });
});

describe('chunked guest file downloads', () => {
  it('reassembles a 29 MiB file exactly without exceeding the bridge frame limit', async () => {
    const expected = Buffer.alloc(29 * 1024 * 1024);
    for (let offset = 0; offset < expected.length; offset += 1024)
      expected[offset] = (offset / 1024) % 256;
    await writeFile(join(folder, 'recording.mp3'), expected);
    const request = vi.fn<Computer['request']>(async (...args) => {
      const result = await guest.request(...args);
      expect(encodeFrame({ id: randomUUID(), result }).length).toBeLessThan(FRAME_LIMIT);
      return result;
    });
    const result = await downloadGuestFile(
      { request },
      'recording.mp3',
      owner,
      signal(),
      ARTIFACT_DOWNLOAD_LIMIT,
    );
    expect(result.name).toBe('recording.mp3');
    expect(result.bytes.equals(expected)).toBe(true);
    expect(request).toHaveBeenCalledTimes(8);
    expect(request.mock.calls[1][1]).toMatchObject({
      offset: ARTIFACT_CHUNK_BYTES,
      version: expect.any(String),
    });
    await expect(
      downloadGuestFile(guest, 'recording.mp3', owner, signal(), 10 * 1024 * 1024),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('downloads empty files and exact chunk boundaries', async () => {
    for (const size of [0, ARTIFACT_CHUNK_BYTES]) {
      const expected = Buffer.alloc(size, 7);
      await writeFile(join(folder, 'file.bin'), expected);
      const result = await downloadGuestFile(
        guest,
        'file.bin',
        owner,
        signal(),
        ARTIFACT_DOWNLOAD_LIMIT,
      );
      expect(result.bytes.equals(expected)).toBe(true);
    }
  });
  it('rejects a file above the UI limit before reading its contents', async () => {
    const file = await open(join(folder, 'large.bin'), 'w');
    try {
      await file.truncate(ARTIFACT_DOWNLOAD_LIMIT + 1);
    } finally {
      await file.close();
    }
    await expect(
      downloadGuestFile(guest, 'large.bin', owner, signal(), ARTIFACT_DOWNLOAD_LIMIT),
    ).rejects.toMatchObject({ status: 413, message: expect.stringContaining('100 MiB') });
  });
  it('rejects files that change between chunks instead of combining different versions', async () => {
    await writeFile(join(folder, 'changing.bin'), Buffer.alloc(ARTIFACT_CHUNK_BYTES + 1));
    const request = vi.fn<Computer['request']>(async (...args) => {
      const result = await guest.request(...args);
      if (request.mock.calls.length === 1)
        await appendFile(join(folder, 'changing.bin'), 'changed');
      return result;
    });
    await expect(
      downloadGuestFile({ request }, 'changing.bin', owner, signal(), ARTIFACT_DOWNLOAD_LIMIT),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('finish writing') });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('stops requesting chunks when the preview is cancelled', async () => {
    await writeFile(join(folder, 'cancel.bin'), Buffer.alloc(ARTIFACT_CHUNK_BYTES + 1));
    const controller = new AbortController();
    const request = vi.fn<Computer['request']>(async (...args) => {
      const result = await guest.request(...args);
      controller.abort(new Error('Preview closed'));
      return result;
    });
    await expect(
      downloadGuestFile(
        { request },
        'cancel.bin',
        owner,
        controller.signal,
        ARTIFACT_DOWNLOAD_LIMIT,
      ),
    ).rejects.toThrow('Preview closed');
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects incomplete replies without retrying indefinitely', async () => {
    const request = vi.fn<Computer['request']>().mockResolvedValue({
      name: 'file',
      offset: 0,
      size: 10,
      bytes: '',
      version: 'v1',
      nextOffset: 0,
    });
    await expect(
      downloadGuestFile({ request }, 'file', owner, signal(), ARTIFACT_DOWNLOAD_LIMIT),
    ).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledOnce();
  });
  it('preserves workspace path boundaries for large downloads', async () => {
    await expect(
      downloadGuestFile(guest, '../outside.bin', owner, signal(), ARTIFACT_DOWNLOAD_LIMIT),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('explains when a running guest still needs the large-file update', async () => {
    const request = vi
      .fn<Computer['request']>()
      .mockRejectedValue(
        new Error(
          JSON.stringify([{ code: 'too_big', maximum: 10 * 1024 * 1024, path: ['maxBytes'] }]),
        ),
      );
    await expect(
      downloadGuestFile({ request }, 'recording.mp3', owner, signal(), ARTIFACT_DOWNLOAD_LIMIT),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Restart the workspace VM'),
    });
  });
});
