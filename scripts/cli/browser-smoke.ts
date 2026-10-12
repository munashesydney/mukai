import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';

async function main() {
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/cli-browser-'));
  const data = join(directory, 'data');
  const child = spawn(
    process.execPath,
    [resolve('dist/cli/app/cli.cjs'), 'serve', '--port', '0', '--data-dir', data],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
  );
  let output = '';
  child.stderr!.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  let browser: Browser | undefined;
  try {
    let state: { url: string; connectionUrl: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        state = JSON.parse(await readFile(join(data, 'cli-server.json'), 'utf8')) as typeof state;
        if (state) break;
      } catch {
        /* Wait for startup. */
      }
      if (child.exitCode !== null) throw new Error(output);
      await setTimeout(100);
    }
    assert.ok(state, output);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(state.connectionUrl);
    await page.getByRole('heading', { name: 'Create your first workspace.' }).waitFor();
    assert.equal(
      new URL(page.url()).hash,
      '',
      'Connection secret must be removed from the address bar.',
    );
    assert.equal(await page.evaluate(() => 'mukai' in window), false);
    await page.screenshot({ path: resolve('artifacts/cli-browser.png') });
    await page.reload();
    await page.getByRole('heading', { name: 'Create your first workspace.' }).waitFor();
    const anonymous = await browser.newContext();
    const disconnected = await anonymous.newPage();
    await disconnected.goto(state.url);
    await disconnected.getByRole('heading', { name: 'Connect to Mukai' }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'Browser smoke passed: shared UI, fragment exchange, refresh persistence, unauthenticated connection screen.',
    );
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.send({ type: 'mukai:shutdown' });
    await Promise.race([
      exited,
      setTimeout(15000).then(() => {
        child.kill();
        throw new Error('Server did not shut down.');
      }),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
