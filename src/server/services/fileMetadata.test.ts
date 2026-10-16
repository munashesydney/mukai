import { describe, expect, it } from 'vitest';
import { fileMetadata } from './fileMetadata';

describe('Artifact file metadata', () => {
  it.each([
    ['photo.bin', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
    ['photo.bin', Buffer.from([255, 216, 255]), 'image/jpeg'],
    ['photo.bin', Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
    ['report.bin', Buffer.from('%PDF-1.7'), 'application/pdf'],
    [
      'document.docx',
      Buffer.from('PK\x03\x04'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['archive.zip', Buffer.from('PK\x03\x04'), 'application/zip'],
    ['fake.png', Buffer.from('ordinary text'), 'text/plain'],
    ['empty.txt', Buffer.alloc(0), 'text/plain'],
    ['data.bin', Buffer.from([255, 128]), 'application/octet-stream'],
    ['data.bin', Buffer.from([65, 1, 66]), 'application/octet-stream'],
    ['notes.md', Buffer.from('# Notes'), 'text/markdown'],
  ])('identifies %s from bytes and preserves the complete byte size', (name, header, mediaType) => {
    expect(fileMetadata(header, name, 12345)).toEqual({ mediaType, size: 12345 });
  });
  it('allows a UTF-8 character to straddle the bounded inspection header', () => {
    expect(fileMetadata(Buffer.from([65, 0xe2, 0x82]), 'notes.txt', 10)).toEqual({
      mediaType: 'text/plain',
      size: 10,
    });
  });
});
