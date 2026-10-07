import { createHash } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

export function imageChecksum(sums: string, filename: string) {
  const line = sums
    .split(/\r?\n/)
    .find((line) => line.replace(/^[a-f0-9]{64}\s+\*?/i, '') === filename);
  const hash = line?.match(/^[a-f0-9]{64}/i)?.[0];
  if (!hash) throw new Error('Ubuntu did not publish a checksum for the Linux image.');
  return hash.toLowerCase();
}
export async function downloadImage(
  url: string,
  destination: string,
  checksum: string,
  signal: AbortSignal,
  progress: (downloadedBytes: number, totalBytes?: number) => void,
) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
  });
  if (!response.ok || !response.body)
    throw new Error(`Linux image download failed (${response.status}).`);
  const total = Number(response.headers.get('content-length')) || undefined;
  const limit = 4 * 1024 ** 3;
  if (total && total > limit) {
    await response.body.cancel();
    throw new Error('Linux image exceeds the download limit.');
  }
  const temporary = destination + '.part';
  const file = await open(temporary, 'w', 0o600);
  let length = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      length += chunk.length;
      if (length > limit) throw new Error('Linux image exceeds the download limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
      progress(length, total);
    }
    if (hash.digest('hex') !== checksum)
      throw new Error('Linux image checksum did not match. Retry to download a fresh copy.');
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  await rename(temporary, destination);
}
