import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { botAvatarIds } from '../src/shared/mascots';

async function main() {
  const directory = resolve('src/renderer/public/mascots');
  let originalBytes = 0;
  let optimizedBytes = 0;
  for (const id of botAvatarIds) {
    const source = resolve(directory, `${id}.png`);
    const destination = resolve(directory, `${id}.webp`);
    originalBytes += (await stat(source)).size;
    const result = await sharp(source)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100, effort: 6 })
      .toFile(destination);
    optimizedBytes += result.size;
  }
  console.log(
    `Optimized ${botAvatarIds.length} mascots: ${originalBytes} → ${optimizedBytes} bytes (${(100 * (1 - optimizedBytes / originalBytes)).toFixed(1)}% smaller).`,
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
