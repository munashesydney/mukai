import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, realpath, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

async function main() {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'mukai-computer-smoke-'));
  const artifactDirectory = resolve('artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  const bundle = join(artifactDirectory, `computer-smoke-${process.pid}.cjs`);
  try {
    await build({
      entryPoints: ['scripts/computer-smoke.ts'],
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
      outfile: bundle,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MUKAI_COMPUTER_SMOKE_DIR: directory,
      NODE_PATH: resolve('node_modules'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const require = createRequire(resolve('package.json'));
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(require('electron') as string, [bundle], {
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 1500000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
  } finally {
    await rm(bundle, { force: true });
    const target = await realpath(directory);
    assert.equal(dirname(target), parent, 'Unexpected cleanup path.');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
