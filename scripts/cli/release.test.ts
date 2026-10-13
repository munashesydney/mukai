import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliReleaseFiles } from './release';
import { cliArchiveName, cliTargets } from './artifacts';
import { installerNames, verifyInstallers } from '../release';

test('complete CLI and desktop release has verified manifest and unified checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-cli-release-'));
  const version = '0.1.0-build.12.1';
  try {
    for (const name of installerNames(version)) await writeFile(join(directory, name), 'desktop');
    for (const name of ['install.sh', 'install.ps1'])
      await writeFile(join(directory, name), 'installer');
    for (const target of cliTargets) {
      const name = cliArchiveName(version, target.platform, target.arch);
      await writeFile(join(directory, name), 'cli');
      await writeFile(
        join(directory, name + '.sha256'),
        createHash('sha256').update('cli').digest('hex') + '\n',
      );
    }
    const extra = await cliReleaseFiles(directory, version);
    const manifest = JSON.parse(await readFile(join(directory, 'cli-manifest.json'), 'utf8')) as {
      artifacts: unknown[];
    };
    assert.equal(manifest.artifacts.length, 4);
    const files = await verifyInstallers(directory, version, 1, extra);
    assert.equal(files.length, 16);
    await writeFile(join(directory, cliArchiveName(version, 'win32', 'x64')), 'tampered');
    await assert.rejects(cliReleaseFiles(directory, version), /checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
