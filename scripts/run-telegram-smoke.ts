import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'mukai-telegram-ui-'));
  const bundle = resolve('artifacts', `telegram-smoke-${process.pid}.cjs`);
  if (
    !resolve(directory).startsWith(resolve(tmpdir(), 'mukai-telegram-ui-')) ||
    !bundle.startsWith(resolve('artifacts') + sep)
  )
    throw new Error('Unexpected cleanup path.');
  mkdirSync('artifacts', { recursive: true });
  try {
    await build({
      entryPoints: ['scripts/telegram-smoke.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
      preserveSymlinks: true,
    });
    const require = createRequire(resolve('package.json'));
    const environment: NodeJS.ProcessEnv = { ...process.env, MUKAI_TELEGRAM_SMOKE_DIR: directory };
    delete environment.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise<number>((done, reject) => {
      const child = spawn(require('electron') as string, [bundle], {
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => {
        console.error('Telegram UI smoke exceeded its two-minute time limit.');
        child.kill();
      }, 120000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        done(code ?? 1);
      });
    });
  } finally {
    rmSync(bundle, { force: true });
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
