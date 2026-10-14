import { app, BrowserWindow, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { TelegramStatus } from '../src/shared/telegram';
import { seedTestWorkspace, seedTestBot } from '../src/server/testFixtures';
import { BotRepository } from '../src/server/repositories/botRepository';
import { scoutBot } from '../src/server/services/botService';
import { themeStorageKey } from '../src/renderer/src/features/appearance/themes';
import { registerDesktopActions } from '../src/main/desktopActions';

/** Uses real Mukai HTTP routes, persistence and polling with a local fake Telegram transport. */
async function main() {
  const directory = process.env.MUKAI_TELEGRAM_SMOKE_DIR;
  if (!directory) throw new Error('A disposable Telegram smoke directory is required.');
  app.setPath('userData', directory);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const sent: { method: string; input: Record<string, unknown> }[] = [];
  const telegramFetch: typeof fetch = async (url, init) => {
    const method = String(url).split('/').at(-1)!;
    const input = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    sent.push({ method, input });
    if (method === 'getUpdates') {
      await new Promise<void>((done) => {
        if (init?.signal?.aborted) return done();
        const timer = setTimeout(done, 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            done();
          },
          { once: true },
        );
      });
    }
    const result =
      method === 'getMe'
        ? { id: 123456, is_bot: true, first_name: 'Mukai', username: 'MukaiQaBot' }
        : method === 'getWebhookInfo'
          ? { url: '' }
          : method === 'getUpdates'
            ? []
            : method === 'sendMessage'
              ? { message_id: sent.length }
              : true;
    return Response.json({ ok: true, result });
  };
  const api = await startApiServer(0, {
    dataDir: join(directory, 'api'),
    telegramFetch,
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestWorkspace(api.store);
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(process.cwd(), 'out/preload/index.js'),
    },
  });
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, () => ({ status: 'ok' }));
  ipcMain.handle(IPC.browserBounds, () => {});
  // Match production restrictions so ordinary popup/clipboard APIs cannot hide broken actions.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  let popupAttempts = 0;
  window.webContents.setWindowOpenHandler(() => {
    popupAttempts++;
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const opened: string[] = [],
    copied: string[] = [];
  let failOpen = false,
    failCopy = false;
  const removeDesktopActions = registerDesktopActions(
    (event) => event.sender === window.webContents && event.senderFrame === event.sender.mainFrame,
    {
      openExternal: async (url) => {
        if (failOpen) throw new Error('Fixture opener failure');
        opened.push(url);
      },
      writeClipboardText: async (text) => {
        if (failCopy) throw new Error('Fixture clipboard failure');
        copied.push(text);
      },
    },
  );
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const wait = async (code: string) => {
    for (let index = 0; index < 200; index++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('Telegram UI did not settle: ' + code);
  };
  const click = (text: string) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(text)}).click()`,
    );
  const capture = async (name: string) => {
    await wait('document.querySelector(".rail-link.is-active")?.textContent.trim()==="Telegram"');
    await wait('document.querySelector(".workspace-navigation").classList.contains("is-compact")');
    await evaluate('document.fonts.ready');
    await evaluate(
      'Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))',
    );
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    mkdirSync('artifacts', { recursive: true });
    writeFileSync(join('artifacts', name), (await window.webContents.capturePage()).toPNG());
  };
  const assertFullWidthCards = async () => {
    assert.equal(
      await evaluate(`(()=>{
      const content=document.querySelector('.telegram-content');
      const style=getComputedStyle(content);
      const available=content.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const grid=document.querySelector('.telegram-setup-grid');
      if(grid && Math.abs(grid.getBoundingClientRect().width-available)>=2) return false;
      return Array.from(document.querySelectorAll('.telegram-card')).every(card=>card.closest('.telegram-setup-grid') || Math.abs(card.getBoundingClientRect().width-available)<2);
    })()`),
      true,
      'Telegram cards must fill the available content width.',
    );
  };
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<T>;
  }
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  try {
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".rail-link:not(:disabled)"))');
    assert.equal(
      await evaluate<boolean>(
        'Array.from(document.querySelectorAll(".rail-link")).find(item=>item.textContent.trim()==="Telegram").disabled',
      ),
      false,
      'Telegram must be available before creating a bot.',
    );
    await click('Telegram');
    await wait('Boolean(document.querySelector("#telegram-token"))');
    assert.equal(await evaluate('document.querySelector("#telegram-token").type'), 'password');
    await evaluate('document.querySelector("#telegram-token").focus()');
    assert.equal(await evaluate('document.activeElement.id'), 'telegram-token');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait('document.activeElement.tagName==="A"');
    // The disabled Connect action is correctly skipped until a token is present.
    await capture('telegram-connect-light.png');
    await assertFullWidthCards();
    assert.equal(
      await evaluate(`(()=>{
      const card=document.querySelector('.telegram-connect').getBoundingClientRect();
      const guide=document.querySelector('.telegram-guide').getBoundingClientRect();
      return guide.left>card.right && Math.abs(guide.top-card.top)<30;
    })()`),
      true,
      'Token setup and quick steps must stay side by side on desktop.',
    );
    window.setSize(680, 820);
    await wait('window.innerWidth<800');
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    assert.equal(
      await evaluate(`(()=>{
      const card=document.querySelector('.telegram-connect').getBoundingClientRect();
      const guide=document.querySelector('.telegram-guide').getBoundingClientRect();
      return guide.top>=card.bottom;
    })()`),
      true,
      'Token setup and quick steps must stack on small screens.',
    );
    await assertFullWidthCards();
    window.setSize(1440, 960);
    await wait('window.innerWidth>1000');
    await evaluate('document.querySelector(".telegram-guide a").click()');
    await wait('true');
    for (let index = 0; opened.length < 1 && index < 100; index++)
      await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(opened, ['https://t.me/BotFather']);
    await evaluate(
      `(()=>{const field=document.querySelector('#telegram-token');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'123456:telegram_ui_disposable_secret_123456');field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click('Connect bot');
    await wait('Boolean(document.querySelector(".telegram-pair-card"))');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".telegram-footer button"))'),
      true,
      'Disconnect must be available while pairing.',
    );
    assert.equal(await evaluate('document.querySelectorAll("input[type=password]").length'), 0);
    assert.equal(
      JSON.stringify(await request('/telegram')).includes('telegram_ui_disposable_secret'),
      false,
    );
    await click('Create pairing link');
    await wait('Boolean(document.querySelector(".telegram-pairing a"))');
    let paired = await request<TelegramStatus>('/telegram');
    assert.match(paired.pairing!.url!, /^https:\/\/t\.me\/MukaiQaBot\?start=/);
    await click('Copy link');
    await wait('document.querySelector(".telegram-pairing")?.textContent.includes("Copied")');
    assert.equal(copied.at(-1), paired.pairing!.url);
    await evaluate('document.querySelector(".telegram-pairing a").click()');
    for (let index = 0; opened.length < 2 && index < 100; index++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(opened.at(-1), paired.pairing!.url);
    assert.equal(popupAttempts, 0, 'Desktop links must use IPC, not a blocked popup.');
    failCopy = true;
    await click('Copied');
    await wait('document.querySelector("[role=alert]")?.textContent.includes("Could not copy")');
    failCopy = false;
    await click('Retry');
    failOpen = true;
    await evaluate('document.querySelector(".telegram-pairing a").click()');
    await wait('document.querySelector("[role=alert]")?.textContent.includes("Could not open")');
    failOpen = false;
    await click('Retry');
    await capture('telegram-pair-light.png');
    await assertFullWidthCards();
    // A persisted pairing challenge has no plaintext code after restarting Mukai.
    api.telegram.connections.pair('a'.repeat(64), Date.now() + 5 * 60000);
    await evaluate('document.querySelector(".telegram-heading button").click()');
    await wait(
      'document.querySelector(".telegram-pair-card")?.textContent.includes("after restarting")',
    );
    await click('Create a new pairing link');
    await wait('Boolean(document.querySelector(".telegram-pairing a"))');
    paired = await request<TelegramStatus>('/telegram');
    api.telegram.accept(api.telegram.connection()!.id, [
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 987654, type: 'private' },
          from: { id: 987654, first_name: 'Sydney', username: 'sydney' },
          text: `/start ${paired.pairing!.code}`,
        },
      },
    ]);
    await wait('Boolean(document.querySelector(".telegram-candidate"))');
    assert.equal(
      (await request<TelegramStatus>('/telegram')).owner,
      null,
      'Sending Start must not grant access.',
    );
    await capture('telegram-approve-light.png');
    seedTestBot(api.store);
    new BotRepository(api.store).create({
      ...scoutBot('default', 'telegram-helper'),
      name: 'Helper',
      isMain: false,
    });
    await click('Yes, pair my account');
    await wait('Boolean(document.querySelector(".telegram-workspace input"))');
    assert.equal((await request<TelegramStatus>('/telegram')).owner!.id, 987654);
    assert.equal(
      (await request<TelegramStatus>('/telegram')).workspaces.some((item) => item.enabled),
      false,
    );
    await evaluate('document.querySelector(".telegram-workspace input").click()');
    await wait('Boolean(document.querySelector(".telegram-bot-select select"))');
    await evaluate(
      `(()=>{const select=document.querySelector('.telegram-bot-select select');select.value='telegram-helper';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await capture('telegram-access-light.png');
    await click('Finish setup');
    await wait('Boolean(document.querySelector(".telegram-overview"))');
    const active = await request<TelegramStatus>('/telegram');
    assert.equal(active.workspaces.find((item) => item.id === 'default')!.botId, 'telegram-helper');
    await capture('telegram-dashboard-light.png');
    await assertFullWidthCards();
    await evaluate('document.querySelector(".telegram-overview a").click()');
    for (let index = 0; opened.length < 3 && index < 100; index++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(opened.at(-1), 'https://t.me/MukaiQaBot');
    assert.equal(popupAttempts, 0);
    await click('Pause');
    await wait('document.querySelector(".telegram-overview h2")?.textContent.includes("paused")');
    assert.equal((await request<TelegramStatus>('/telegram')).enabled, false);
    await click('Resume');
    await wait(
      'document.querySelector(".telegram-overview h2")?.textContent.includes("message away")',
    );
    await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'ocean' });
    await evaluate(`localStorage.removeItem(${JSON.stringify(themeStorageKey)})`);
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('document.documentElement.dataset.mode==="dark"');
    await click('Telegram');
    await wait('Boolean(document.querySelector(".telegram-overview"))');
    await capture('telegram-dashboard-dark.png');
    window.setSize(680, 820);
    await capture('telegram-dashboard-narrow-dark.png');
    await assertFullWidthCards();
    assert.equal(
      await evaluate(
        'document.querySelector(".telegram-page").scrollWidth<=document.querySelector(".telegram-page").clientWidth',
      ),
      true,
      'Telegram content must fit its narrow viewport.',
    );
    await click('Revoke paired account');
    assert.ok(
      (await request<TelegramStatus>('/telegram')).owner,
      'Revoking must wait for confirmation.',
    );
    await click('Revoke access');
    await wait('Boolean(document.querySelector(".telegram-pair-card"))');
    assert.equal((await request<TelegramStatus>('/telegram')).owner, null);
    await click('Disconnect bot');
    await evaluate('document.querySelector(".telegram-confirm .telegram-danger").click()');
    await wait('Boolean(document.querySelector("#telegram-token"))');
    assert.equal((await request<TelegramStatus>('/telegram')).configured, false);
    assert.ok(
      sent.some((item) => item.method === 'getUpdates'),
      'The backend must start the poller.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS Telegram UI: native clipboard and external links under denied Chromium permissions, actionable failures, empty-bot navigation, masked token, real API connect/pair/approve/access, explicit owner confirmation, bot override, pause/resume, revoke/disconnect, keyboard focus, light/dark and narrow layouts.',
    );
  } catch (error) {
    await capture('telegram-smoke-failure.png');
    throw error;
  } finally {
    removeDesktopActions();
    window.destroy();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
