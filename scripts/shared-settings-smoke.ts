import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, async () => (await fetch(api.url + '/health')).json());
  ipcMain.handle(IPC.browserBounds, () => {});
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
    await api.shutdown();
    await new Promise<void>((done) => api.server.close(() => done()));
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
    await api.shutdown();
    await new Promise<void>((done) => api.server.close(() => done()));
    api = await startApiServer(0, { dataDir });
    desktopWindow = createDesktopWindow();
    await desktopWindow.loadFile(resolve('out/renderer/index.html'));
    await wait(
      `document.documentElement.dataset.theme === 'graphite' && document.documentElement.dataset.mode === 'dark'`,
    );
    console.log(
      'Shared settings smoke passed: native path, desktop migration, browser cache override, UI saving and rollback, focus sync, reload, and desktop round trip.',
    );
  } finally {
    if (!desktopWindow.isDestroyed()) desktopWindow.destroy();
    await browser?.close();
    await api.shutdown();
    await new Promise<void>((done) => api.server.close(() => done()));
  }
}
void main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
