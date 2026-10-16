import { extname } from 'node:path';
import type { FileMetadata } from '../../shared/fileMetadata';

/** Inspect a bounded header, never decode a whole image just to list a file. */
export function fileMetadata(header: Buffer, name: string, size = header.length): FileMetadata {
  let mediaType = 'application/octet-stream';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    mediaType = 'image/png';
  else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) mediaType = 'image/jpeg';
  else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
    mediaType = 'image/webp';
  else if (header.toString('ascii', 0, 5) === '%PDF-') mediaType = 'application/pdf';
  else if (header[0] === 0x50 && header[1] === 0x4b && extname(name).toLowerCase() === '.docx')
    mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  else if (header[0] === 0x50 && header[1] === 0x4b) mediaType = 'application/zip';
  else if (!header.includes(0)) {
    try {
      // Streaming permits a multi-byte character to straddle the bounded header.
      new TextDecoder('utf-8', { fatal: true }).decode(header, { stream: true });
      if (!header.some((byte) => byte < 32 && ![9, 10, 13].includes(byte))) {
        const extension = extname(name).toLowerCase();
        mediaType =
          extension === '.json'
            ? 'application/json'
            : extension === '.md'
              ? 'text/markdown'
              : 'text/plain';
      }
    } catch {
      /* Unknown binary stays application/octet-stream. */
    }
  }
  return { mediaType, size };
}
