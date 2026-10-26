import type { FileArtifact } from '../../../../shared/ai';

type PreviewFile = Pick<FileArtifact, 'name' | 'kind' | 'mediaType'>;
export function artifactIsImage(file: PreviewFile) {
  return (
    file.kind === 'image' ||
    file.mediaType?.startsWith('image/') ||
    ((!file.mediaType || file.mediaType === 'application/octet-stream') &&
      /\.(png|jpe?g|webp|gif|avif|bmp|ico)$/i.test(file.name))
  );
}

/** Keep binary bytes and large documents out of the text renderer. */
export async function artifactPreview(
  blob: Blob,
  file: PreviewFile,
): Promise<
  | { kind: 'image'; mediaType: string }
  | { kind: 'text'; content: string }
  | { kind: 'unavailable'; message: string }
> {
  const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  let mediaType = blob.type.split(';')[0].toLowerCase();
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte))
    mediaType = 'image/png';
  else if (header[0] === 255 && header[1] === 216 && header[2] === 255) mediaType = 'image/jpeg';
  else if (
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
  )
    mediaType = 'image/webp';
  if (
    mediaType.startsWith('image/') ||
    ((!mediaType || mediaType === 'application/octet-stream') && artifactIsImage(file))
  )
    return {
      kind: 'image',
      mediaType: mediaType.startsWith('image/')
        ? mediaType
        : file.mediaType || 'application/octet-stream',
    };
  const unsupported = {
    kind: 'unavailable' as const,
    message: 'This file cannot be previewed here. Download it to open it on your computer.',
  };
  if (
    mediaType &&
    mediaType !== 'application/octet-stream' &&
    !mediaType.startsWith('text/') &&
    !['application/json', 'application/xml', 'application/javascript', 'application/yaml'].includes(
      mediaType,
    )
  )
    return unsupported;
  if (blob.size > 256 * 1024)
    return {
      kind: 'unavailable',
      message: 'This file is too large for a text preview. Download it to view the full contents.',
    };
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.some((byte) => byte < 32 && ![9, 10, 13].includes(byte))) return unsupported;
    return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return unsupported;
  }
}
