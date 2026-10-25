import { ApiError } from '../config';

const invalid = (message: string): never => {
  throw new ApiError(400, message);
};

/** Bounded container checks; the provider still validates the encoded media stream. */
export function mediaAttachment(
  extension: string,
  bytes: Buffer,
): { kind: 'audio' | 'video'; mediaType: string } {
  if (extension === '.wav') {
    const fail = () =>
      invalid('This WAV file is invalid or truncated. Upload a complete PCM WAV or MP3 file.');
    if (
      bytes.length < 44 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE'
    )
      fail();
    const end = bytes.readUInt32LE(4) + 8;
    if (end > bytes.length || end < 44) fail();
    let format = false,
      data = false;
    for (let offset = 12; offset < end;) {
      if (offset + 8 > end) fail();
      const id = bytes.toString('ascii', offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > end) fail();
      if (id === 'fmt ') {
        if (size < 16) fail();
        const codec = bytes.readUInt16LE(start),
          channels = bytes.readUInt16LE(start + 2),
          rate = bytes.readUInt32LE(start + 4);
        if (![1, 3].includes(codec))
          invalid('This WAV codec is unsupported. Convert the recording to PCM WAV or MP3.');
        if (
          !channels ||
          channels > 32 ||
          !rate ||
          !bytes.readUInt16LE(start + 12) ||
          !bytes.readUInt16LE(start + 14)
        )
          fail();
        format = true;
      }
      if (id === 'data' && size > 0) data = true;
      offset = start + size + (size % 2);
    }
    if (!format || !data) fail();
    return { kind: 'audio', mediaType: 'audio/wav' };
  }
  if (extension === '.mp3') {
    const fail = () =>
      invalid('This MP3 file is invalid or truncated. Upload a complete MP3 recording.');
    let offset = 0;
    if (bytes.toString('ascii', 0, 3) === 'ID3') {
      if (bytes.length < 10 || [...bytes.subarray(6, 10)].some((value) => value > 127)) fail();
      offset =
        10 +
        ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) +
        (bytes[5] & 0x10 ? 10 : 0);
    }
    if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 0xe0) !== 0xe0)
      fail();
    const version = (bytes[offset + 1] >> 3) & 3,
      layer = (bytes[offset + 1] >> 1) & 3;
    const rateIndex = (bytes[offset + 2] >> 2) & 3,
      bitrateIndex = bytes[offset + 2] >> 4;
    if (
      version === 1 ||
      layer !== 1 ||
      rateIndex === 3 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15
    )
      fail();
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const kbps = (
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[bitrateIndex];
    const frameLength =
      Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) +
      ((bytes[offset + 2] >> 1) & 1);
    if (offset + frameLength > bytes.length) fail();
    return { kind: 'audio', mediaType: 'audio/mpeg' };
  }
  const fail = () =>
    invalid(
      'This video is invalid, audio-only, or incomplete. Upload a complete MP4 or MOV video with a video track.',
    );
  let fileType = false,
    mediaData = false,
    video = false;
  function boxes(start: number, end: number, depth: number) {
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) fail();
      let size = bytes.readUInt32BE(offset),
        header = 8;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (size === 1) {
        if (offset + 16 > end) fail();
        const extended = bytes.readBigUInt64BE(offset + 8);
        if (extended > BigInt(end - offset)) fail();
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) fail();
      const payload = offset + header;
      if (depth === 0 && type === 'ftyp' && size >= header + 8) {
        const brand = bytes.toString('ascii', payload, payload + 4);
        if (/^M4[ABP]/.test(brand)) fail();
        fileType = true;
      }
      if (depth === 0 && type === 'mdat' && size > header) mediaData = true;
      if (['moov', 'trak', 'mdia'].includes(type) && depth < 3)
        boxes(payload, offset + size, depth + 1);
      if (
        depth === 3 &&
        type === 'hdlr' &&
        size >= header + 12 &&
        bytes.toString('ascii', payload + 8, payload + 12) === 'vide'
      )
        video = true;
      offset += size;
    }
  }
  boxes(0, bytes.length, 0);
  if (!fileType || !mediaData || !video) fail();
  return { kind: 'video', mediaType: extension === '.mov' ? 'video/quicktime' : 'video/mp4' };
}
