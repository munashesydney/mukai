import { expect, it } from 'vitest';
import { mediaAttachment } from './mediaAttachment';
import { wavFixture, mp3Fixture, mp4Fixture } from '../testMediaFixtures';

it('accepts complete WAV/MP3 and video containers with matching media types', () => {
  expect(mediaAttachment('.wav', wavFixture())).toEqual({ kind: 'audio', mediaType: 'audio/wav' });
  expect(mediaAttachment('.mp3', mp3Fixture())).toEqual({ kind: 'audio', mediaType: 'audio/mpeg' });
  expect(mediaAttachment('.mp4', mp4Fixture())).toEqual({ kind: 'video', mediaType: 'video/mp4' });
  expect(mediaAttachment('.mov', mp4Fixture())).toEqual({
    kind: 'video',
    mediaType: 'video/quicktime',
  });
});
it.each([
  ['.wav', wavFixture()],
  ['.mp3', mp3Fixture()],
  ['.mp4', mp4Fixture()],
] as const)('rejects empty, disguised and truncated %s files', (extension, bytes) => {
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from('renamed text file'),
    bytes.subarray(0, bytes.length - 1),
  ])
    expect(() => mediaAttachment(extension, bad)).toThrow(/invalid|truncated|incomplete/);
});
it('rejects audio-only MP4 and invalid or oversized atom lengths without scanning past the buffer', () => {
  expect(() => mediaAttachment('.mp4', mp4Fixture('soun'))).toThrow('audio-only');
  const overflow = mp4Fixture();
  overflow.writeUInt32BE(0xffffffff, 0);
  expect(() => mediaAttachment('.mp4', overflow)).toThrow('invalid');
  const extended = Buffer.alloc(16);
  extended.writeUInt32BE(1);
  extended.write('ftyp', 4);
  extended.writeBigUInt64BE(2n ** 63n, 8);
  expect(() => mediaAttachment('.mp4', extended)).toThrow('invalid');
});
it('rejects unsupported WAV codecs and tag-only MP3 files', () => {
  const wav = wavFixture();
  wav.writeUInt16LE(99, 20);
  expect(() => mediaAttachment('.wav', wav)).toThrow('codec');
  expect(() => mediaAttachment('.mp3', Buffer.from('ID3\x04\0\0\0\0\0\0'))).toThrow('invalid');
});
