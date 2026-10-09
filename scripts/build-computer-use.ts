import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function main() {
  const directory = resolve('dist/computer_use');
  await mkdir(directory, { recursive: true });
  for (const file of ['windows.ps1', 'linux.py', 'linux_wayland.py', 'macos.swift']) {
    await writeFile(
      resolve(directory, file),
      (await readFile(resolve('scripts/computer_use', file), 'utf8')).replace(/\r\n/g, '\n'),
    );
  }
  if (process.platform === 'darwin') {
    // Compile on the target host: packaged users do not need Xcode or Swift installed.
    await new Promise<void>((resolveBuild, reject) => {
      const child = spawn(
        '/usr/bin/xcrun',
        [
          'swiftc',
          '-swift-version',
          '5',
          '-parse-as-library',
          '-O',
          '-target',
          `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
          resolve(directory, 'macos.swift'),
          '-o',
          resolve(directory, 'macos'),
        ],
        { stdio: 'inherit' },
      );
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolveBuild()
          : reject(new Error(`macOS desktop helper build failed (${code}).`)),
      );
    });
  }
  console.log('Desktop helpers ready in dist/computer_use.');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
