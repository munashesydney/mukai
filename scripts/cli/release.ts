import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliArchiveName, cliTargets } from './artifacts.ts';

export async function cliReleaseFiles(directory: string, version: string) {
  const artifacts = [];
  const files = ['install.sh', 'install.ps1'];
  for (const target of cliTargets) {
    const file = cliArchiveName(version, target.platform, target.arch);
    const checksum = (await readFile(join(directory, file + '.sha256'), 'utf8')).trim();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
    if (!/^[a-f0-9]{64}$/.test(checksum) || hash.digest('hex') !== checksum)
      throw new Error(`Invalid CLI checksum: ${file}`);
    files.push(file, file + '.sha256');
    artifacts.push({ platform: target.platform, arch: target.arch, file, sha256: checksum });
  }
  await writeFile(
    join(directory, 'cli-manifest.json'),
    JSON.stringify({ schemaVersion: 1, version, artifacts }, null, 2) + '\n',
  );
  files.push('cli-manifest.json');
  return files;
}
