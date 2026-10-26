/** Small container fixtures for validation and mock-provider transport tests, not playback. */
export function wavFixture() {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(68, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(32, 40);
  return bytes;
}
export function mp3Fixture() {
  const bytes = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0]).copy(bytes);
  return bytes;
}
export function mp4Fixture(handler = 'vide') {
  const box = (type: string, data: Buffer) => {
    const result = Buffer.alloc(8 + data.length);
    result.writeUInt32BE(result.length);
    result.write(type, 4);
    data.copy(result, 8);
    return result;
  };
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom')),
    box(
      'moov',
      box('trak', box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler)])))),
    ),
    box('mdat', Buffer.alloc(16)),
  ]);
}
