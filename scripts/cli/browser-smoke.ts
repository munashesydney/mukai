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
    await page.getByRole('heading', { name: 'Connect your Mukai.' }).waitFor();
    const code = new URLSearchParams(new URL(state.connectionUrl).hash.slice(1)).get(
      'mukai-setup',
    )!;
    await page.getByLabel('Setup code').fill('');
    await page.screenshot({ path: resolve('artifacts/auth-setup-light.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.locator('.auth-header .brand').isVisible(),
      'Mukai branding must remain visible on mobile.',
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Auth screen must fit a phone viewport.',
    );
    await page.screenshot({ path: resolve('artifacts/auth-setup-mobile.png') });
    await page.setViewportSize({ width: 1480, height: 940 });
    await page.getByLabel('Setup code').fill('wrong-code');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'incorrect or expired' }).waitFor();
    await page.getByLabel('Setup code').fill(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Make it yours.' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Make it yours.' }).waitFor();
    await page.screenshot({ path: resolve('artifacts/auth-create-login.png') });
    await page.getByLabel('Username', { exact: true }).fill('smoke+owner@example.com');
    await page.getByLabel('Password', { exact: true }).fill('disposable smoke password');
    await page.getByLabel('Confirm password', { exact: true }).fill('disposable smoke password');
    await page.getByRole('button', { name: 'Create login & open Mukai' }).click();
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
    await disconnected.getByRole('heading', { name: 'Welcome back.' }).waitFor();
    await disconnected.screenshot({ path: resolve('artifacts/auth-login-light.png') });
    await disconnected.evaluate(() =>
      localStorage.setItem('mukai.appearance.v1', JSON.stringify({ mode: 'dark', theme: 'ocean' })),
    );
    await disconnected.reload();
    await disconnected.getByRole('heading', { name: 'Welcome back.' }).waitFor();
    await disconnected.screenshot({ path: resolve('artifacts/auth-login-dark.png') });
    await disconnected.getByLabel('Username', { exact: true }).fill('smoke+owner@example.com');
    await disconnected.getByLabel('Password', { exact: true }).fill('wrong-password');
    await disconnected.getByRole('button', { name: 'Sign in', exact: true }).click();
    await disconnected.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await disconnected.getByLabel('Password', { exact: true }).fill('disposable smoke password');
    await disconnected.getByRole('button', { name: 'Sign in', exact: true }).click();
    await disconnected.getByRole('heading', { name: 'Create your first workspace.' }).waitFor();
    await disconnected.getByRole('button', { name: 'Sign out', exact: true }).click();
    await disconnected.getByRole('heading', { name: 'Welcome back.' }).waitFor();
    await disconnected.reload();
    await disconnected.getByRole('heading', { name: 'Welcome back.' }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'Browser smoke passed: owner code, setup proof refresh, account creation, login, session refresh, sign-out, and responsive auth screens.',
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
