import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mukai-bot-smoke-'));
  const bundle = resolve('artifacts', `bot-smoke-${process.pid}.cjs`);
  if (
    !resolve(dir).startsWith(resolve(tmpdir(), 'mukai-bot-smoke-')) ||
    !bundle.startsWith(resolve('artifacts') + sep)
  )
    throw new Error('Unexpected cleanup path.');
  try {
    await build({
      entryPoints: ['scripts/bot-smoke.ts'],
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
      outfile: bundle,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, MUKAI_BOT_SMOKE_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(require('electron') as string, [bundle], {
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 120000);
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
    rmSync(bundle, { force: true });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
