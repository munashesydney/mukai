import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
async function run() {
  const root = mkdtempSync(join(tmpdir(), 'mukai-capability-smoke-'));
  if (!root.startsWith(join(tmpdir(), 'mukai-capability-smoke-')))
    throw new Error('Unexpected smoke data directory; refusing cleanup.');
  const bundle = join(process.cwd(), 'out', `capability-smoke-${process.pid}.cjs`);
  try {
    await build({
      entryPoints: ['scripts/capability-smoke.ts'],
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron'],
      outfile: bundle,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, MUKAI_CAPABILITY_SMOKE_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise<number>((resolve, reject) => {
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
        resolve(code ?? 1);
      });
    });
  } finally {
    rmSync(bundle, { force: true });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
