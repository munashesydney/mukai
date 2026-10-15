import { app, BrowserWindow, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { TelegramStatus } from '../src/shared/telegram';
import { seedTestWorkspace, seedTestBot } from '../src/server/testFixtures';
import { BotRepository } from '../src/server/repositories/botRepository';
import { WorkspaceRepository } from '../src/server/repositories/workspaceRepository';
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
  const clickNamed = (name: string) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(item=>item.getAttribute('aria-label')===${JSON.stringify(name)}).click()`,
    );
  const assertNoInnerScrolling = async () => {
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.telegram-workspace-card,.telegram-workspace-card *')).every(element=>!['auto','scroll'].includes(getComputedStyle(element).overflowY))`,
      ),
      true,
      'Workspace cards must grow with their rows and use the page scrollbar.',
    );
  };
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
  const assertFocusedLayout = async () => {
    assert.equal(
      await evaluate(`(()=>{
      const page=document.querySelector('.telegram-page'), content=document.querySelector('.telegram-content');
      const style=getComputedStyle(page), pageRect=page.getBoundingClientRect(), contentRect=content.getBoundingClientRect();
      const available=page.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const maximum=content.matches('.telegram-content--workspaces,.telegram-content--connected')?720:560;
      return Math.abs(contentRect.width-Math.min(maximum,available))<2
        && Math.abs(contentRect.left+contentRect.width/2-(pageRect.left+page.clientWidth/2))<2
        && page.scrollWidth<=page.clientWidth;
    })()`),
      true,
      'Telegram should use a focused, centered layout that fits the viewport.',
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
    await wait('document.activeElement.tagName==="SUMMARY"');
    // The disabled Connect action is correctly skipped until a token is present.
    await capture('telegram-connect-light.png');
    await assertFocusedLayout();
    window.setSize(680, 820);
    await wait('window.innerWidth<800');
    await capture('telegram-connect-narrow-light.png');
    await assertFocusedLayout();
    window.setSize(1440, 960);
    await wait('window.innerWidth>1000');
    await evaluate('document.querySelector(".telegram-guide summary").click()');
    await evaluate('document.querySelector(".telegram-guide a").click()');
    await wait('true');
    for (let index = 0; opened.length < 1 && index < 100; index++)
      await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(opened, ['https://t.me/BotFather']);
    await evaluate(
      `(()=>{const field=document.querySelector('#telegram-token');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'123456:telegram_ui_disposable_secret_123456');field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click('Connect');
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
    assert.equal(
      await evaluate('document.querySelector(".telegram-command code").textContent'),
      '/start ' + paired.pairing!.code,
      'The manual pairing command should be visible without expanding a disclosure.',
    );
    await evaluate('document.querySelector(".telegram-command button").click()');
    await wait('document.querySelector(".telegram-command button").textContent.includes("Copied")');
    assert.equal(copied.at(-1), '/start ' + paired.pairing!.code);
    await capture('telegram-pair-light.png');
    await assertFocusedLayout();
    // A persisted pairing challenge has no plaintext code after restarting Mukai.
    api.telegram.connections.pair('a'.repeat(64), Date.now() + 5 * 60000);
    await evaluate('document.querySelector(".telegram-settings").open=true');
    await evaluate('document.querySelector(".telegram-refresh").click()');
    await wait(
      'document.querySelector(".telegram-pair-card")?.textContent.includes("after restarting")',
    );
    await evaluate('document.querySelector(".telegram-settings").open=false');
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
    const workspaces = new WorkspaceRepository(api.store);
    for (const [index, name] of [
      'Design',
      'Research',
      'Writing',
      'Planning',
      'Personal',
      'Empty workspace',
    ].entries()) {
      const id = 'telegram-workspace-' + index;
      workspaces.create({
        id,
        name,
        folder: null,
        computer: 'local',
        createdAt: new Date().toISOString(),
      });
      if (name !== 'Empty workspace')
        new BotRepository(api.store).create(scoutBot(id, id + '-bot'));
    }
    await click('Yes, pair my account');
    await wait('Boolean(document.querySelector(".telegram-workspace-card"))');
    assert.equal((await request<TelegramStatus>('/telegram')).owner!.id, 987654);
    assert.equal(
      (await request<TelegramStatus>('/telegram')).workspaces.some((item) => item.enabled),
      false,
    );
    await clickNamed('Add workspaces');
    await wait('Boolean(document.querySelector(".telegram-workspace-choice input"))');
    await evaluate('document.querySelector(".telegram-workspace-choice input").click()');
    await click('Done');
    await clickNamed('Configure Test workspace');
    await wait('Boolean(document.querySelector(".telegram-bot-options"))');
    await click('Helper');
    await click('Add all');
    await wait('document.querySelectorAll(".telegram-workspace-row").length===6');
    assert.equal(
      await evaluate('document.querySelector(".telegram-row-bot").textContent'),
      'Helper',
      'Add all must preserve existing bot choices.',
    );
    await clickNamed('Add workspaces');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".telegram-workspace-choice .themed-checkbox").length',
      ),
      7,
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".telegram-workspace-choice input:disabled:checked").length',
      ),
      0,
      'Unavailable workspaces must not be added.',
    );
    await click('Done');
    await capture('telegram-access-light.png');
    await assertFocusedLayout();
    await assertNoInnerScrolling();
    await click('Finish setup');
    await wait('Boolean(document.querySelector(".telegram-overview"))');
    const active = await request<TelegramStatus>('/telegram');
    assert.equal(active.workspaces.find((item) => item.id === 'default')!.botId, 'telegram-helper');
    assert.equal(active.workspaces.filter((item) => item.enabled).length, 6);
    assert.equal(
      await evaluate('document.querySelectorAll(".telegram-page details").length'),
      1,
      'Connection settings should be the only disclosure on the connected page.',
    );
    assert.equal(await evaluate('document.querySelectorAll(".telegram-workspace-row").length'), 6);
    await capture('telegram-dashboard-light.png');
    await assertFocusedLayout();
    // Workspace changes save directly from the same card after setup.
    await clickNamed('Configure Design');
    await click('Remove workspace');
    await wait(
      'document.querySelectorAll(".telegram-workspace-row").length===5 && !document.querySelector(".telegram-add-workspace").disabled',
    );
    assert.equal(
      (await request<TelegramStatus>('/telegram')).workspaces.find(
        (item) => item.name === 'Design',
      )!.enabled,
      false,
    );
    await clickNamed('Add workspaces');
    await evaluate(
      'document.querySelector(".telegram-workspace-choice input[aria-label=Design]").click()',
    );
    await wait('!document.querySelector(".telegram-card-done").disabled');
    await click('Done');
    await wait('document.querySelectorAll(".telegram-workspace-row").length===6');
    assert.equal(
      (await request<TelegramStatus>('/telegram')).workspaces.find(
        (item) => item.name === 'Design',
      )!.enabled,
      true,
    );
    await evaluate('document.querySelector(".telegram-overview a").click()');
    for (let index = 0; opened.length < 3 && index < 100; index++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(opened.at(-1), 'https://t.me/MukaiQaBot');
    assert.equal(popupAttempts, 0);
    await clickNamed('Pause connection');
    await wait('document.querySelector(".telegram-overview h1")?.textContent.includes("paused")');
    assert.equal(
      await evaluate(
        'document.querySelector(".telegram-connected-account button").getAttribute("aria-label")',
      ),
      'Resume connection',
    );
    assert.equal((await request<TelegramStatus>('/telegram')).enabled, false);
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".telegram-connected-account .telegram-dot")).backgroundColor',
      ),
      'rgb(42, 159, 237)',
    );
    await capture('telegram-paused-light.png');
    await clickNamed('Resume connection');
    await wait(
      'document.querySelector(".telegram-overview h1")?.textContent.includes("connected")',
    );
    await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'ocean' });
    await evaluate(`localStorage.removeItem(${JSON.stringify(themeStorageKey)})`);
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('document.documentElement.dataset.mode==="dark"');
    await click('Telegram');
    await wait('Boolean(document.querySelector(".telegram-overview"))');
    // Sample the actual hover transition: the button must stay opaque throughout.
    const buttonBounds = await evaluate<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector(".telegram-overview .telegram-primary").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()',
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...buttonBounds });
    const hoverSamples = await evaluate<{ image: string; color: string }[]>(
      `(async()=>{const button=document.querySelector('.telegram-primary'), samples=[];for(let i=0;i<12;i++){await new Promise(done=>requestAnimationFrame(done));const style=getComputedStyle(button);samples.push({image:style.backgroundImage,color:style.backgroundColor});}return samples;})()`,
    );
    assert.ok(
      hoverSamples.every((sample) => sample.image === 'none' && /^rgb\(/.test(sample.color)),
      'Primary button hover must not flash through a transparent gradient background.',
    );
    await capture('telegram-dashboard-dark.png');
    await clickNamed('Configure Test workspace');
    await capture('telegram-bot-picker-dark.png');
    await click('Main botFollows this workspace’s main bot');
    await wait(
      'document.querySelector(".telegram-row-bot").textContent==="Main bot" && !document.querySelector(".telegram-add-workspace").disabled',
    );
    assert.equal(
      (await request<TelegramStatus>('/telegram')).workspaces.find((item) => item.id === 'default')!
        .botId,
      null,
    );
    await clickNamed('Add workspaces');
    await capture('telegram-add-workspaces-dark.png');
    window.setSize(680, 820);
    await capture('telegram-add-workspaces-narrow-dark.png');
    await assertFocusedLayout();
    await assertNoInnerScrolling();
    await evaluate('document.querySelector(".telegram-card-done").scrollIntoView()');
    await click('Done');
    await wait('document.activeElement===document.querySelector(".telegram-card-heading h2")');
    assert.equal(
      await evaluate(
        '(()=>{const r=document.activeElement.getBoundingClientRect();return r.top>=document.querySelector(".telegram-page").getBoundingClientRect().top && r.bottom<=window.innerHeight;})()',
      ),
      true,
      'Returning from a long workspace list should bring the card heading into view.',
    );
    await evaluate('document.querySelector(".telegram-page").scrollTop=0');
    await capture('telegram-dashboard-narrow-dark.png');
    await assertFocusedLayout();
    await assertNoInnerScrolling();
    await evaluate('document.querySelector(".telegram-settings summary").click()');
    await click('Revoke paired account');
    await wait('Boolean(document.querySelector("dialog.confirmation-modal[open]"))');
    assert.equal(
      await evaluate('document.querySelectorAll("dialog.confirmation-modal input").length'),
      0,
    );
    assert.ok(
      (await request<TelegramStatus>('/telegram')).owner,
      'Revoking must wait for confirmation.',
    );
    await click('Revoke access');
    await wait('Boolean(document.querySelector(".telegram-pair-card"))');
    assert.equal((await request<TelegramStatus>('/telegram')).owner, null);
    await evaluate(
      '(()=>{const details=document.querySelector(".telegram-settings"); if(!details.open) details.querySelector("summary").click();})()',
    );
    await click('Disconnect bot');
    await wait('Boolean(document.querySelector("dialog.confirmation-modal[open]"))');
    await capture('telegram-disconnect-confirmation.png');
    assert.equal((await request<TelegramStatus>('/telegram')).configured, true);
    await evaluate('document.querySelector(".confirmation-modal .modal-footer .button").click()');
    await wait('!document.querySelector("dialog.confirmation-modal")');
    assert.equal((await request<TelegramStatus>('/telegram')).configured, true);
    await click('Disconnect bot');
    await evaluate('document.querySelector(".confirmation-modal .button--danger").click()');
    await wait('Boolean(document.querySelector("#telegram-token"))');
    assert.equal((await request<TelegramStatus>('/telegram')).configured, false);
    window.setSize(1440, 960);
    await capture('telegram-connect-dark.png');
    await assertFocusedLayout();
    window.setSize(680, 820);
    await capture('telegram-connect-narrow-dark.png');
    await assertFocusedLayout();
    assert.ok(
      sent.some((item) => item.method === 'getUpdates'),
      'The backend must start the poller.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS Telegram UI: native clipboard and links, visible pairing command, shared workspace card for setup and connected views, add all with preserved bot choices, direct workspace add/remove and bot changes, unavailable workspaces, pause/play icon, blue status dot, no nested scrolling or shortcut disclosures, hover transitions, connection settings, light/dark and narrow layouts.',
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
