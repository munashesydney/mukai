import { ComputerUseService } from '../src/server/services/computerUseService';
import { NativeDesktopBackend } from '../src/server/computer/computer_use/nativeBackend';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

async function main() {
  if (process.argv.includes('--interactive')) {
    const bundle = resolve('artifacts', `computer-use-smoke-${process.pid}.cjs`);
    await mkdir(resolve('artifacts'), { recursive: true });
    try {
      await build({
        entryPoints: ['scripts/computer-use-smoke.ts'],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        packages: 'external',
      });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const require = createRequire(resolve('package.json'));
      await new Promise<void>((done, reject) => {
        // GTK and the display backend initialize before the smoke script runs.
        const switches =
          process.platform === 'linux' && env.XDG_SESSION_TYPE === 'x11'
            ? ['--ozone-platform=x11', '--gtk-version=3']
            : [];
        const child = spawn(require('electron') as string, [...switches, bundle], {
          env,
          stdio: 'inherit',
          windowsHide: false,
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Desktop smoke test timed out.'));
        }, 90000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else reject(new Error(`Desktop smoke test failed (${code}).`));
        });
      });
    } finally {
      await rm(bundle, { force: true });
    }
    return;
  }
  const service = new ComputerUseService(new NativeDesktopBackend());
  const owner = { workspaceId: 'computer-use-smoke', botId: 'smoke', conversationId: 'read-only' };
  const signal = AbortSignal.timeout(60000);
  try {
    const status = (await service.execute(owner, { action: 'status' }, signal)) as {
      available: boolean;
    };
    console.log('Desktop status:', status);
    assert.equal(status.available, true, 'The native desktop must be ready.');
    const displays = await service.execute(owner, { action: 'displays' }, signal);
    console.log('Displays:', displays);
    const screenshot = (await service.execute(owner, { action: 'screenshot' }, signal)) as {
      image: string;
      width: number;
      height: number;
    };
    const directory = resolve('artifacts/computer_use');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `smoke-${Date.now()}.png`);
    await writeFile(path, Buffer.from(screenshot.image, 'base64'));
    assert.ok(screenshot.width > 0 && screenshot.height > 0);
    console.log(`Captured ${screenshot.width}×${screenshot.height}: ${path}`);
  } finally {
    await service.shutdown();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
