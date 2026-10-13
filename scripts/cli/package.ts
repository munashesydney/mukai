import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cliArchiveName } from './artifacts';

async function main() {
  const source = resolve('dist/cli');
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
    version: string;
    platform: string;
    arch: string;
    node: string;
  };
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error('Build CLI on the target platform before packaging.');
  if (!process.versions.node.startsWith('24.')) throw new Error('Package CLI with Node 24 LTS.');
  await mkdir('release', { recursive: true });
  const stage = await mkdtemp(resolve('release/cli-stage-'));
  const root = join(stage, 'mukai');
  try {
    await cp(source, root, { recursive: true });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'bin'), { recursive: true });
    await cp(
      process.execPath,
      join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    );
    // npm prunes a staged copy of the lockfile, including platform-specific optional addons.
    // The source checkout and its development dependencies are never modified.
    await cp('package.json', join(root, 'app/package.json'));
    await cp('package-lock.json', join(root, 'app/package-lock.json'));
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (process.platform === 'win32') {
      execFileSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'],
        { cwd: join(root, 'app'), stdio: 'inherit' },
      );
    } else
      execFileSync(npmCommand, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: join(root, 'app'),
        stdio: 'inherit',
      });
    const appPackage = JSON.parse(await readFile(join(root, 'app/package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const key of ['build', 'scripts', 'devDependencies']) delete appPackage[key];
    appPackage.main = 'cli.cjs';
    await writeFile(join(root, 'app/package.json'), JSON.stringify(appPackage, null, 2) + '\n');
    if (process.platform === 'win32') {
      await writeFile(
        join(root, 'bin/mukai.cmd'),
        '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\cli.cjs" %*\r\nexit /b %errorlevel%\r\n',
      );
    } else {
      await writeFile(
        join(root, 'bin/mukai'),
        '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/runtime/node" "$base/app/cli.cjs" "$@"\n',
      );
      await chmod(join(root, 'bin/mukai'), 0o755);
      await chmod(join(root, 'runtime/node'), 0o755);
    }
    await writeFile(
      join(root, 'README.txt'),
      'Mukai CLI\nRun bin/mukai (Windows: bin\\mukai.cmd) --help.\nData is stored outside this installation.\n',
    );
    // Preserve the runtime license from official setup-node distributions.
    const nodeLicense = join(resolve(process.execPath, '..'), '..', 'LICENSE');
    const flatLicense = join(resolve(process.execPath, '..'), 'LICENSE');
    const license = [flatLicense, nodeLicense].find((file) => existsSync(file));
    if (license) await cp(license, join(root, 'runtime/LICENSE'));
    else {
      const response = await fetch(
        `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok) throw new Error('Cannot obtain bundled Node license.');
      await writeFile(join(root, 'runtime/LICENSE'), await response.text());
    }
    await writeFile(
      join(root, 'LICENSE.txt'),
      'Mukai is proprietary software. Copyright Mukai. All rights reserved.\nThird-party dependencies retain their licenses, included with their packages.\n',
    );
    const archive = resolve(
      'release',
      cliArchiveName(manifest.version, process.platform, process.arch),
    );
    if (process.platform === 'win32') {
      // Fixed script + environment arguments avoid interpreting installation paths as shell code.
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.IO.Compression.FileSystem; if ([IO.File]::Exists($env:MUKAI_ARCHIVE)) { [IO.File]::Delete($env:MUKAI_ARCHIVE) }; [IO.Compression.ZipFile]::CreateFromDirectory($env:MUKAI_STAGE, $env:MUKAI_ARCHIVE, [IO.Compression.CompressionLevel]::Fastest, $false)',
        ],
        { env: { ...process.env, MUKAI_STAGE: stage, MUKAI_ARCHIVE: archive }, stdio: 'inherit' },
      );
    } else execFileSync('tar', ['-czf', archive, '-C', stage, 'mukai'], { stdio: 'inherit' });
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(archive + '.sha256', sha256 + '\n');
    console.log(`Packaged ${archive}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
