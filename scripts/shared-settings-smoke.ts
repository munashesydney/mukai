import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startApiServer } from '../src/server/app';
import { defaultDataDir } from '../src/server/config';
import { IPC } from '../src/shared/contracts';

const root = process.env.MUKAI_SETTINGS_SMOKE_DIR!;
if (!root) throw new Error('Temporary settings smoke directory is required.');
app.setName('mukai');
assert.equal(
  defaultDataDir(),
  join(app.getPath('userData'), 'data'),
  'CLI default must match the desktop runtime.',
);
app.setPath('userData', join(root, 'desktop-profile'));
// This test deliberately switches from a desktop window to browser mode in one process.
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const dataDir = join(root, 'data');
  let api = await startApiServer(0, { dataDir });
  const closingApis = new WeakMap<typeof api, Promise<void>>();
  const closeApi = () => {
    const current = api;
    const pending = closingApis.get(current);
    if (pending) return pending;
    const closing = (async () => {
      // Stop accepting requests first; hidden renderers can retain unfinished HTTP connections.
      const closed = new Promise<void>((done, reject) =>
        current.server.close((error) => (error ? reject(error) : done())),
      );
      await current.shutdown();
      current.server.closeAllConnections();
      await closed;
    })();
    closingApis.set(current, closing);
    return closing;
  };
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, async () => (await fetch(api.url + '/health')).json());
  ipcMain.handle(IPC.browserBounds, () => {});
  ipcMain.handle(IPC.updateState, () => ({ status: 'disabled', currentVersion: '0.1.0' }));
  const createDesktopWindow = () =>
    new BrowserWindow({
      show: false,
      width: 1480,
      height: 940,
      webPreferences: {
        preload: resolve('out/preload/index.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
  let desktopWindow = createDesktopWindow();
  const wait = async (expression: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await desktopWindow.webContents.executeJavaScript(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Desktop condition did not settle: ${expression}`);
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await desktopWindow.loadFile(resolve('out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".workspace-first-run"))');
    assert.equal(
      await desktopWindow.webContents.executeJavaScript('document.documentElement.dataset.theme'),
      'ocean',
      'A fresh desktop installation must use Ocean.',
    );
    await desktopWindow.webContents.executeJavaScript(
      `localStorage.setItem('mukai.appearance.v1', JSON.stringify({mode:'dark',theme:'ocean'}))`,
    );
    await desktopWindow.loadFile(resolve('out/renderer/index.html'));
    await wait(
      `document.documentElement.dataset.theme === 'ocean' && document.documentElement.dataset.mode === 'dark'`,
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (api.store.get('SELECT value FROM app_settings WHERE key=?', 'appearance')) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.deepEqual(
      JSON.parse(
        String(api.store.get('SELECT value FROM app_settings WHERE key=?', 'appearance')?.value),
      ),
      { mode: 'dark', theme: 'ocean' },
    );
    desktopWindow.destroy();
    // Keep an incomplete request open to verify teardown cannot wait on renderer sockets.
    const unfinished = connect(Number(new URL(api.url).port), '127.0.0.1');
    unfinished.on('error', () => {});
    await once(unfinished, 'connect');
    unfinished.write('GET /health HTTP/1.1\r\n');
    const disconnected = new Promise<void>((done) => unfinished.once('close', () => done()));
    try {
      await closeApi();
      await disconnected;
    } finally {
      unfinished.destroy();
    }
    api = await startApiServer(0, { dataDir, webDir: resolve('dist/web') });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1480, height: 940 } });
    const page = await context.newPage();
    // An old browser cache must lose to the shared desktop preference.
    await context.addInitScript(() =>
      localStorage.setItem('mukai.appearance.v1', JSON.stringify({ mode: 'light', theme: 'rose' })),
    );
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.theme === 'ocean' &&
        document.documentElement.dataset.mode === 'dark',
    );
    assert.deepEqual(
      await page.evaluate(async () => (await fetch('/api/settings/appearance')).json()),
      { appearance: { mode: 'dark', theme: 'ocean' } },
    );
    await mkdir('artifacts', { recursive: true });
    await writeFile(resolve('artifacts/shared-appearance.png'), await page.screenshot());
    const project = join(root, 'project');
    await mkdir(project);
    assert.equal(
      await page.evaluate(async (folder) => {
        const response = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Shared settings workspace', folder }),
        });
        return response.status;
      }, project),
      201,
    );
    await page.reload();
    await page.getByRole('button', { name: 'Open settings' }).click();
    // The user avatar opens the same shared floating surface as composer pickers.
    const profileTrigger = page
      .getByRole('button', { name: 'Customize your profile icon' })
      .first();
    await profileTrigger.click();
    const profileCard = page.getByRole('dialog', { name: 'Make it yours' });
    await profileCard.getByRole('button', { name: 'Rocket', exact: true }).click();
    await profileCard.getByRole('button', { name: 'Forest background' }).click();
    await writeFile(resolve('artifacts/profile-customizer.png'), await page.screenshot());
    await profileCard.getByRole('button', { name: 'Save', exact: true }).click();
    await profileCard.waitFor({ state: 'detached' });
    assert.equal(
      await profileTrigger.getByRole('img').getAttribute('aria-label'),
      'Your profile: Rocket',
    );
    await profileTrigger.click();
    await profileCard.getByRole('button', { name: 'Letter', exact: true }).click();
    const initials = profileCard.getByLabel('Letter or initials');
    await initials.fill('SY');
    await initials.press('Home');
    assert.equal(
      await initials.evaluate((input: HTMLInputElement) => input.selectionStart),
      0,
      'The shared popup must preserve text-input navigation in dialog mode.',
    );
    await page.route('**/api/settings/profile', async (route) => {
      if (route.request().method() === 'PUT')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary profile failure' }),
        });
      else await route.continue();
    });
    await profileCard.getByRole('button', { name: 'Save', exact: true }).click();
    await profileCard.getByRole('alert').waitFor();
    assert.equal(await initials.inputValue(), 'SY');
    assert.equal(
      await profileTrigger.getByRole('img').getAttribute('aria-label'),
      'Your profile: Rocket',
    );
    await page.unroute('**/api/settings/profile');
    await profileCard.getByRole('button', { name: 'Save', exact: true }).click();
    await profileCard.waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await profileTrigger.getByRole('img', { name: 'Your profile: SY', exact: true }).waitFor();
    await profileTrigger.click();
    await profileCard.getByRole('button', { name: 'Reset', exact: true }).click();
    await profileCard.getByRole('img', { name: 'Your profile: User', exact: true }).waitFor();
    await profileCard.press('Escape');
    await profileCard.waitFor({ state: 'detached' });
    assert.equal(
      await profileTrigger.getByRole('img').getAttribute('aria-label'),
      'Your profile: SY',
      'Dismissed drafts must not overwrite the saved profile.',
    );
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.locator('label.mode-option:has(input[value="light"])').click();
    await page.locator('label.theme-option:has(input[value="iris"])').click();
    await page.locator('.appearance-live').filter({ hasText: 'Saved across Mukai' }).waitFor();
    assert.deepEqual(
      await page.evaluate(async () => (await fetch('/api/settings/appearance')).json()),
      { appearance: { mode: 'light', theme: 'iris' } },
    );
    // Failed saves roll back the preview and retain the confirmed database setting.
    await page.route('**/api/settings/appearance', async (route) => {
      if (route.request().method() === 'PUT')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary settings save failure' }),
        });
      else await route.continue();
    });
    await page.locator('label.theme-option:has(input[value="ember"])').click();
    await page.getByRole('alert').filter({ hasText: 'Temporary settings save failure' }).waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'iris');
    await page.unroute('**/api/settings/appearance');
    // A change from another client is picked up by the open browser on focus.
    await page.evaluate(async () => {
      await fetch('/api/settings/appearance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'dark', theme: 'graphite' }),
      });
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.theme === 'graphite' &&
        document.documentElement.dataset.mode === 'dark',
    );
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'graphite');
    await browser.close();
    browser = undefined;
    await closeApi();
    api = await startApiServer(0, { dataDir });
    desktopWindow = createDesktopWindow();
    await desktopWindow.loadFile(resolve('out/renderer/index.html'));
    await wait(
      `document.documentElement.dataset.theme === 'graphite' && document.documentElement.dataset.mode === 'dark'`,
    );
    await desktopWindow.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Open settings"]')?.click()`,
    );
    await wait(
      `Boolean(document.querySelector('.user-avatar-trigger [aria-label="Your profile: SY"]'))`,
    );
    assert.deepEqual(
      await (
        await fetch(api.url + '/settings/profile', {
          headers: { Authorization: `Bearer ${api.token}` },
        })
      ).json(),
      { mode: 'letter', letter: 'SY', icon: 'rocket', background: '#438571' },
    );
  } finally {
    console.log('Shared settings smoke: closing desktop, browser and backend.');
    if (!desktopWindow.isDestroyed()) desktopWindow.destroy();
    await browser?.close();
    await closeApi();
  }
  console.log(
    'Shared settings smoke passed: appearance and profile UI, failed-save retry, keyboard navigation, reload, desktop/browser persistence, and connection cleanup.',
  );
}
void main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
