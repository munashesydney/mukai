import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { installerNames } from '../release';
import { desktopUpdateNames } from '../desktop-updates';

export async function writeDesktopRelease(directory: string, version: string) {
  const payload = 'installer';
  for (const name of [...installerNames(version), ...desktopUpdateNames(version)])
    if (!name.endsWith('.yml')) await writeFile(join(directory, name), payload);
  const manifest = (files: string[]) =>
    stringify({
      version,
      files: files.map((url) => ({
        url,
        size: payload.length,
        sha512: createHash('sha512').update(payload).digest('base64'),
      })),
    });
  await writeFile(join(directory, 'latest.yml'), manifest([installerNames(version)[0]]));
  await writeFile(join(directory, 'latest-linux.yml'), manifest([installerNames(version)[3]]));
  for (const arch of ['x64', 'arm64'])
    await writeFile(
      join(directory, `latest-mac-${arch}.yml`),
      manifest([`Mukai-${version}-mac-${arch}.zip`, `Mukai-${version}-mac-${arch}.dmg`]),
    );
}
