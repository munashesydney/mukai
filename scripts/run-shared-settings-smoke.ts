import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-shared-settings-'));
  const bundle = resolve('artifacts', `shared-settings-${process.pid}.cjs`);
  await mkdir(join(directory, 'desktop-profile'));
  await mkdir('artifacts', { recursive: true });
  try {
    await build({
      entryPoints: ['scripts/shared-settings-smoke.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
    });
    const require = createRequire(resolve('package.json'));
    const environment: NodeJS.ProcessEnv = { ...process.env, MUKAI_SETTINGS_SMOKE_DIR: directory };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.MUKAI_DATA_DIR;
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(require('electron') as string, [bundle], {
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 60000);
      child.once('error', reject);
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        done(exitCode ?? 1);
      });
    });
    process.exitCode = code;
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(bundle, { force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
