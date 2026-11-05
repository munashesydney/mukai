import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import { formatTimestamp } from '../src/shared/timeZone';
import type { Workspace } from '../src/shared/ai';

const root = process.env.MUKAI_TIMEZONE_SMOKE_DIR!;
if (!root) throw new Error('An isolated timezone smoke directory is required.');
app.setPath('userData', join(root, 'desktop-profile'));
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const api = await startApiServer(0, { dataDir: join(root, 'data') });
  const folder = join(root, 'project');
  await mkdir(folder);
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, async () => (await fetch(api.url + '/health')).json());
  ipcMain.handle(IPC.browserBounds, () => {});
  ipcMain.handle(IPC.chooseWorkspaceFolder, () => folder);
  ipcMain.handle(IPC.updateState, () => ({
    status: 'disabled',
    currentVersion: 'test',
    automaticUpdates: false,
  }));
  const window = new BrowserWindow({
    show: false,
    width: 1480,
    height: 940,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const evaluate = (code: string) => window.webContents.executeJavaScript(code);
  const capture = async (name: string) => {
    await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    await mkdir('artifacts', { recursive: true });
    await writeFile(resolve('artifacts', name), (await window.webContents.capturePage()).toPNG());
  };
  const wait = async (expression: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    await capture('timezone-failure.png');
    throw new Error('Timed out: ' + expression);
  };
  const click = (label: string) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).findLast(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
  const fill = (selector: string, value: string) =>
    evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const request = async <T>(path: string, method = 'GET', input?: unknown): Promise<T> => {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const openTimezone = async () => {
    await evaluate(`document.querySelector('button[aria-label="Open settings"]').click()`);
    await wait(`Boolean(document.querySelector('#settings-tab-timezone'))`);
    await evaluate(`document.querySelector('#settings-tab-timezone').click()`);
    await wait(
      `Boolean(document.querySelector('#settings-tab-timezone[aria-selected="true"]')) && Boolean(document.querySelector('.timezone-settings'))`,
    );
  };
  try {
    await window.loadFile(resolve('out/renderer/index.html'));
    await wait(`Boolean(document.querySelector('.workspace-first-run button'))`);
    await click('Create workspace');
    await wait(`Boolean(document.querySelector('.timezone-field input'))`);
    assert.equal(
      await evaluate(`document.querySelector('.timezone-field input').value`),
      await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`),
    );
    await fill('.workspace-editor input[maxlength="60"]', 'Vancouver workspace');
    await click('Browse');
    await fill('.timezone-field input', 'America/Vancouver');
    await capture('timezone-creation.png');
    await click('Create workspace');
    await wait(`Boolean(document.querySelector('.sidebar-empty strong'))`);
    const workspace = (await request<Workspace[]>('/workspaces'))[0];
    assert.equal(workspace.timeZone, 'America/Vancouver');
    const bot = await request<{ id: string }>('/bots', 'POST', {
      workspaceId: workspace.id,
      name: 'Clock',
      role: 'Assistant',
      instructions: 'Help.',
      providerId: null,
      model: null,
      supportsImages: null,
      avatar: 'scout',
    });
    const timestamp = '2026-11-05T02:00:00.000Z';
    api.store.run(
      `INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('timezone-message',?,?,?,'user','Historical clock example','complete',?)`,
      bot.id,
      'bot-' + bot.id,
      'timezone-request',
      timestamp,
    );
    await window.reload();
    await wait(`document.querySelectorAll('.ai-message time').length > 0`);
    const before = await evaluate(`document.querySelector('.ai-message time').textContent`);
    assert.equal(
      before,
      formatTimestamp(timestamp, 'America/Vancouver', { hour: 'numeric', minute: '2-digit' }),
    );
    await openTimezone();
    await fill('.timezone-field input', 'invalid');
    assert.equal(
      await evaluate(`document.querySelector('.timezone-settings button[type=submit]').disabled`),
      true,
    );
    await fill('.timezone-field input', 'Asia/Kathmandu');
    await click('Save timezone');
    await wait(
      `document.querySelector('.timezone-settings [role=status].ai-notice')?.textContent.includes('saved')`,
    );
    assert.equal((await request<Workspace[]>('/workspaces'))[0].timeZone, 'Asia/Kathmandu');
    await capture('timezone-settings.png');
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(button => button.textContent.trim() === 'Bots').click()`,
    );
    await wait(`document.querySelectorAll('.ai-message time').length > 0`);
    assert.equal(
      await evaluate(`document.querySelector('.ai-message time').textContent`),
      formatTimestamp(timestamp, 'Asia/Kathmandu', { hour: 'numeric', minute: '2-digit' }),
    );
    assert.notEqual(
      await evaluate(`document.querySelector('.ai-message time').textContent`),
      before,
    );
    await window.reload();
    await wait(`document.querySelectorAll('.ai-message time').length > 0`);
    assert.equal(
      await evaluate(`document.querySelector('.ai-message time').textContent`),
      formatTimestamp(timestamp, 'Asia/Kathmandu', { hour: 'numeric', minute: '2-digit' }),
    );
    await openTimezone();
    window.setSize(960, 640);
    await capture('timezone-settings-narrow.png');
    assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
    // A legacy workspace initializes once without changing the other workspace.
    const legacyFolder = join(root, 'legacy');
    await mkdir(legacyFolder);
    const legacy = await request<Workspace>('/workspaces', 'POST', {
      name: 'Legacy workspace',
      folder: legacyFolder,
    });
    api.store.run('UPDATE workspaces SET time_zone=NULL WHERE id=?', legacy.id);
    await evaluate(`localStorage.setItem('mukai.active-workspace', ${JSON.stringify(legacy.id)})`);
    await window.loadFile(resolve('out/renderer/index.html'));
    await wait(`Boolean(document.querySelector('.sidebar-empty strong'))`);
    const detected = await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
    assert.equal(api.workspaces.require(legacy.id).timeZone, detected);
    assert.equal(api.workspaces.require(workspace.id).timeZone, 'Asia/Kathmandu');
    await openTimezone();
    assert.equal(await evaluate(`document.querySelector('.timezone-field input').value`), detected);
    await evaluate(
      `localStorage.setItem('mukai.active-workspace', ${JSON.stringify(workspace.id)})`,
    );
    await window.loadFile(resolve('out/renderer/index.html'));
    await wait(`document.querySelectorAll('.ai-message time').length > 0`);
    assert.equal(
      await evaluate(`document.querySelector('.ai-message time').textContent`),
      formatTimestamp(timestamp, 'Asia/Kathmandu', { hour: 'numeric', minute: '2-digit' }),
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS Electron timezone UI: detection, creation, validation, save, historical chat conversion, reload persistence, and narrow layout.',
    );
  } finally {
    window.destroy();
    const closed = new Promise<void>((done) => api.server.close(() => done()));
    api.server.closeAllConnections();
    await api.shutdown();
    await closed;
    api.dispose();
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
