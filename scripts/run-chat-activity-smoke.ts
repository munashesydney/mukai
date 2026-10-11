import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mukai-activity-smoke-'));
  const bundle = resolve('artifacts', `activity-smoke-${process.pid}.cjs`);
  if (
    !resolve(dir).startsWith(resolve(tmpdir(), 'mukai-activity-smoke-')) ||
    !bundle.startsWith(resolve('artifacts', 'activity-smoke-'))
  )
    throw new Error('Unexpected smoke paths; refusing cleanup.');
  try {
    await build({
      entryPoints: ['scripts/chat-activity-smoke.ts'],
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
      outfile: bundle,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, MUKAI_ACTIVITY_SMOKE_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise<number>((done, reject) => {
      const child = spawn(require('electron') as string, [bundle], {
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 60000);
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
