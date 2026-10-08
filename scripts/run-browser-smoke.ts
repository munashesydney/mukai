import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
async function run() {
  const root = mkdtempSync(join(tmpdir(), 'mukai-browser-smoke-'));
  const bundle = join(process.cwd(), 'out', `browser-smoke-${process.pid}.cjs`);
  try {
    await build({
      entryPoints: ['scripts/browser-smoke.ts'],
      bundle: true,
      platform: 'node',
      packages: 'external',
      external: ['electron', 'playwright-core'],
      outfile: bundle,
    });
    const executable = require('electron') as string;
    const env: NodeJS.ProcessEnv = { ...process.env, MUKAI_BROWSER_SMOKE_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [bundle, ...process.argv.slice(2)], {
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    rmSync(bundle, { force: true });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
