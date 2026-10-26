import { describe, expect, it } from 'vitest';
import { telegramMediaLabel, telegramMediaMethod, telegramMediaReferences } from './media';
import { fileMetadata } from '../services/fileMetadata';

describe('Telegram answer media', () => {
  it('collects explicit files and remote media, deduplicating links and line references', () => {
    const answer = `![Screenshot](mukai://artifact/shot)
[Original](mukai://artifact/shot#L12)
[Report](./report.pdf#L2)
[Report again](report.pdf#L3)
[Audio][audio]
![Remote image](https://example.com/download?id=123)
[Video](https://example.com/movie.mp4?download=1)
[Website](https://example.com/article)
[Email](mailto:person@example.com)

[audio]: https://example.com/song.mp3
`;
    expect(telegramMediaReferences(answer)).toEqual([
      { href: 'mukai://artifact/shot', label: 'Screenshot' },
      { href: './report.pdf#L2', label: 'Report' },
      { href: 'https://example.com/song.mp3', label: 'Audio' },
      { href: 'https://example.com/download?id=123', label: 'Remote image' },
      { href: 'https://example.com/movie.mp4?download=1', label: 'Video' },
    ]);
  });
  it('does not interpret code examples, prose paths, fragments or dangerous schemes as attachments', () => {
    expect(
      telegramMediaReferences(
        '`![Example](mukai://artifact/private)`\n\n' +
          '```md\n[File](secret.txt)\n```\n\n' +
          'See notes.txt. [Jump](#section) [Bad](file:///etc/passwd) ' +
          '[Bad](javascript:alert) [Bad](https://user:password@example.com/movie.mp4)',
      ),
    ).toEqual([]);
  });
  it.each([
    ['photo.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'sendPhoto'],
    ['song.mp3', Buffer.from('ID3'), 'sendAudio'],
    ['song.m4a', Buffer.from('\0\0\0\x18ftypM4A '), 'sendAudio'],
    ['clip.mp4', Buffer.from('\0\0\0\x18ftypisom'), 'sendVideo'],
    ['animation.gif', Buffer.from('GIF89a'), 'sendAnimation'],
    ['sound.wav', Buffer.from('RIFF\0\0\0\0WAVE'), 'sendDocument'],
    ['report.pdf', Buffer.from('%PDF-1.7'), 'sendDocument'],
    ['not-an-image.png', Buffer.from('Plain text'), 'sendDocument'],
  ])('selects a native player or preserves %s as a downloadable file', (name, bytes, method) => {
    expect(telegramMediaMethod({ name, bytes, ...fileMetadata(bytes, name) })).toBe(method);
  });
  it('keeps large photos downloadable and bounds captions without splitting emoji', () => {
    expect(
      telegramMediaMethod({
        name: 'large.png',
        mediaType: 'image/png',
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
      }),
    ).toBe('sendDocument');
    const label = telegramMediaLabel('x\n' + '🌱'.repeat(500));
    expect(label.length).toBeLessThanOrEqual(700);
    expect(label).not.toMatch(/[\p{Cc}\uD800-\uDBFF]$/u);
  });
});
