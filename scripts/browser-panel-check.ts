import { ipcMain, type BrowserWindow, type WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { MukaiBrowserHost } from '../src/main/embeddedBrowserHost';
import { checkContextPanel } from './context-panel-check';
import { checkChatGPTPanel } from './chatgpt-panel-check';

// Exercise the production renderer and native view together, using only test data.
export async function checkBrowserPanel(
  window: BrowserWindow,
  host: MukaiBrowserHost,
  dir: string,
  fixtureUrl: string,
) {
  const api = await startApiServer(0, { dataDir: join(dir, 'panel-api'), embeddedBrowser: host });
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const wait = async (predicate: () => Promise<boolean> | boolean, name = 'browser panel') => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(name + ' did not settle');
  };
  for (const [channel, callback] of [
    [IPC.apiConnection, () => ({ url: api.url, token: api.token })],
    [IPC.health, () => ({ status: 'ok' })],
    [IPC.browserBounds, (value: Parameters<typeof host.bounds>[0]) => host.bounds(value)],
  ] as const)
    ipcMain.handle(channel, (event, value) => {
      assert.equal(event.sender, window.webContents);
      return callback(value);
    });
  try {
    console.log('Checking production browser panel');
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait(() => evaluate<boolean>('Boolean(document.querySelector(".header-actions"))'));
    await checkContextPanel(window, api);
    await checkChatGPTPanel(window);
    const owner = { workspaceId: 'default', botId: 'scout', conversationId: 'bot-scout' };
    await api.browsers.execute(
      owner,
      { action: 'open', target: 'mukai', url: fixtureUrl },
      new AbortController().signal,
    );
    await wait(() =>
      evaluate<boolean>('Boolean(document.querySelector(".browser-resize-handle"))'),
    );
    const view = window.contentView.children[0] as WebContentsView;
    await wait(() => view.getVisible());
    console.log('Browser panel and native view visible');
    const layout = () =>
      evaluate<{
        x: number;
        y: number;
        width: number;
        height: number;
        panelWidth: number;
      }>(`(() => {
      const rect=document.querySelector('.browser-viewport').getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,panelWidth:document.querySelector('.browser-panel').getBoundingClientRect().width};
    })()`);
    const before = await layout();
    const handle = await evaluate<{ x: number; y: number }>(`(() => {
      const r=document.querySelector('.browser-resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    window.focus();
    window.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(handle.x),
      y: Math.round(handle.y),
    });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      x: Math.round(handle.x),
      y: Math.round(handle.y),
    });
    await wait(() => !view.getVisible(), 'native view hidden for drag');
    for (const offset of [20, 40, 60]) {
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        modifiers: ['leftbuttondown'],
        x: Math.round(handle.x + offset),
        y: Math.round(handle.y),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: Math.round(handle.x + 60),
      y: Math.round(handle.y),
    });
    await wait(() => view.getVisible(), 'native view restored after drag');
    const after = await layout();
    assert(after.panelWidth < before.panelWidth - 30, JSON.stringify({ before, after, handle }));
    assert.equal(view.getBounds().width, Math.round(after.width));
    assert.equal(view.getBounds().x, Math.round(after.x));
    window.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate<void>('document.querySelector(".browser-resize-handle").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await wait(async () => (await layout()).panelWidth === after.panelWidth + 20, 'keyboard width');
    await evaluate<void>('document.querySelector("button[aria-controls=browser-panel]").click()');
    await wait(() => !view.getVisible());
    assert(
      await evaluate<boolean>(
        '!document.querySelector(".browser-panel") && !document.querySelector(".browser-reopen")',
      ),
    );
    await evaluate<void>('document.querySelector("button[aria-controls=browser-panel]").click()');
    await wait(() => view.getVisible());
    assert.equal((await layout()).panelWidth, after.panelWidth + 20);
    const [originalWidth, originalHeight] = window.getSize();
    window.focus();
    window.webContents.focus();
    window.setSize(960, originalHeight);
    await wait(
      async () => (await evaluate<number>('window.innerWidth')) === window.getContentSize()[0],
      'renderer viewport resize',
    );
    await wait(async () => (await layout()).panelWidth < after.panelWidth, 'window shrink width');
    await wait(
      async () => view.getBounds().width === Math.round((await layout()).width),
      'window shrink native bounds',
    );
    const smaller = await layout();
    assert(smaller.x + smaller.width <= window.getContentSize()[0] + 1);
    window.setSize(originalWidth, originalHeight);
    await wait(
      async () => (await layout()).panelWidth === after.panelWidth + 20,
      'restored window width',
    );
    const loaded = new Promise<void>((resolve) =>
      window.webContents.once('did-finish-load', () => resolve()),
    );
    window.reload();
    await loaded;
    await wait(() => evaluate<boolean>('Boolean(document.querySelector(".browser-panel"))'));
    await wait(() => view.getVisible());
    assert.equal((await layout()).panelWidth, after.panelWidth + 20);
    console.log(
      'PASS browser panel: native drag, keyboard resizing, bounds, window resize, header hide/reopen, persistence',
    );
  } finally {
    for (const channel of [IPC.apiConnection, IPC.health, IPC.browserBounds])
      ipcMain.removeHandler(channel);
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
  }
}
