import { describe, expect, it } from 'vitest';
import { artifactIsImage, artifactPreview } from './artifactPreviewContent';

describe('Artifact previews', () => {
  it('recognizes copied image files without the screenshot kind', () => {
    expect(artifactIsImage({ name: 'copied.bin', mediaType: 'image/png' })).toBe(true);
    expect(artifactIsImage({ name: 'legacy-copy.png' })).toBe(true);
    expect(artifactIsImage({ name: 'notes.png', mediaType: 'text/plain' })).toBe(false);
  });
  it('uses pixels instead of decoding legacy PNG responses as text, even when large or mislabeled', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(
      await artifactPreview(new Blob([bytes], { type: 'text/plain' }), { name: 'copy.png' }),
    ).toEqual({ kind: 'image', mediaType: 'image/png' });
  });
  it('previews bounded UTF-8 text and empty files', async () => {
    expect(await artifactPreview(new Blob(['# Café 👋']), { name: 'notes.md' })).toEqual({
      kind: 'text',
      content: '# Café 👋',
    });
    expect(await artifactPreview(new Blob(), { name: 'empty.txt' })).toEqual({
      kind: 'text',
      content: '',
    });
  });
  it.each([
    ['recording.mp3', 'audio/mpeg', 'audio'],
    ['recording.wav', 'audio/wav', 'audio'],
    ['recording.m4a', 'audio/mp4', 'audio'],
    ['recording.opus', 'audio/ogg', 'audio'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['clip.webm', 'video/webm', 'video'],
    ['clip.mov', 'video/quicktime', 'video'],
    ['document.pdf', 'application/pdf', 'pdf'],
  ])('recognizes %s by MIME type or extension', async (name, mediaType, kind) => {
    const bytes = new Uint8Array([0, 255, 100]);
    expect(await artifactPreview(new Blob([bytes], { type: mediaType }), { name })).toEqual({
      kind,
      mediaType,
    });
    expect(
      await artifactPreview(new Blob([bytes], { type: 'application/octet-stream' }), { name }),
    ).toEqual({ kind, mediaType });
    expect(await artifactPreview(new Blob([bytes]), { name: 'file.bin', mediaType })).toEqual({
      kind,
      mediaType,
    });
  });
  it('recognizes PDF bytes even if the response is mislabeled', async () => {
    expect(
      await artifactPreview(new Blob(['%PDF-1.7'], { type: 'text/plain' }), { name: 'file.bin' }),
    ).toEqual({ kind: 'pdf', mediaType: 'application/pdf' });
  });
  it('preserves an explicit text MIME type instead of treating the extension as media', async () => {
    expect(
      await artifactPreview(new Blob(['Notes about audio'], { type: 'text/plain' }), {
        name: 'notes.mp3',
      }),
    ).toEqual({ kind: 'text', content: 'Notes about audio' });
  });
  it('offers downloads for binary files and documents that would overwhelm a text preview', async () => {
    expect(
      await artifactPreview(new Blob([new Uint8Array([0, 255, 100])]), { name: 'file.bin' }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      await artifactPreview(new Blob(['x'.repeat(256 * 1024 + 1)], { type: 'text/plain' }), {
        name: 'large.txt',
      }),
    ).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('too large') });
  });
});
