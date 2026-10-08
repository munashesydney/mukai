// Real Electron/Chrome integration check using only a disposable profile and a local fixture.
// Bundle with esbuild (electron/playwright-core external), then run the bundle with Electron.
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { MukaiBrowserHost } from '../src/main/embeddedBrowserHost';
import { BrowserService } from '../src/server/services/browserService';
import type { BrowserTarget } from '../src/shared/runtime';
import { checkBrowserPanel } from './browser-panel-check';
import { checkSharedChromeProfiles, checkSharedInlineProfiles } from './browser-profile-check';

async function main() {
  const dir =
    process.env.MUKAI_BROWSER_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'mukai-browser-smoke-'));
  app.setPath('userData', dir);
  await app.whenReady();
  console.log('Starting disposable browser integration check');
  const window = new BrowserWindow({
    show: true,
    width: 1480,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(process.cwd(), 'out/preload/index.js'),
    },
  });
  await window.loadURL('about:blank');
  const host = new MukaiBrowserHost();
  host.attach(window);
  const service = new BrowserService(dir, host);
  const server = createServer((_req, res) =>
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        '<!doctype html><title>Browser fixture</title><h1>Local fixture</h1><label>Message<input id="message" /></label><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value; document.querySelector(\'#count\').textContent=Number(document.querySelector(\'#count\').textContent)+1">Apply</button><span id="count">0</span><input type="password" value="test-secret"/>',
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await checkSharedChromeProfiles(dir, url);
    await checkSharedInlineProfiles(host, url);
    if (process.argv.includes('--profiles-only')) return;
    for (const target of ['mukai', 'chrome'] as BrowserTarget[]) {
      console.log('Checking ' + target);
      const owner = { workspaceId: 'test', botId: 'scout', conversationId: target };
      const signal = new AbortController().signal;
      const opened = (await service.execute(owner, { action: 'open', target, url }, signal)) as {
        tab: { id: string };
      };
      const id = opened.tab.id;
      console.log(target + ' tab opened');
      if (target === 'mukai') {
        const [width, height] = window.getContentSize();
        host.bounds({ id, x: 0, y: 0, width, height });
      }
      let snapshot:
        { title: string; text: string; controls: { ref: string; name: string }[] } | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          snapshot = (await service.execute(
            owner,
            { action: 'snapshot', sessionId: id },
            signal,
          )) as typeof snapshot;
        } catch {
          /* Navigation may replace the initial execution context. */
        }
        if (snapshot?.title === 'Browser fixture') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(snapshot?.title, 'Browser fixture');
      console.log(target + ' snapshot loaded');
      assert(!JSON.stringify(snapshot).includes('test-secret'));
      const input = snapshot!.controls.find((control) => control.name === 'Message')!;
      const button = snapshot!.controls.find((control) => control.name === 'Apply')!;
      assert(input && button);
      await service.execute(
        owner,
        { action: 'type', sessionId: id, ref: input.ref, text: 'Updated by browser tool' },
        signal,
      );
      await service.execute(owner, { action: 'click', sessionId: id, ref: button.ref }, signal);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const changed = (await service.execute(
        owner,
        { action: 'snapshot', sessionId: id },
        signal,
      )) as { text: string };
      assert(changed.text.includes('Updated by browser tool'));
      await service.execute(owner, { action: 'press', sessionId: id, key: 'Space' }, signal);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const keyboard = (await service.execute(
        owner,
        { action: 'snapshot', sessionId: id },
        signal,
      )) as { text: string };
      assert(keyboard.text.includes('Apply2'));
      await assert.rejects(
        service.execute(owner, { action: 'click', sessionId: id, ref: button.ref }, signal),
      );
      await service.execute(owner, { action: 'screenshot', sessionId: id }, signal);
      assert(service.screenshot(id).length > 1000);
      await service.execute(owner, { action: 'close', sessionId: id }, signal);
      assert.equal(service.list('test').length, 0);
      console.log(
        `PASS ${target}: navigation, isolated references, type/click/keyboard, stale refs, password masking, screenshot, close`,
      );
    }
    await checkBrowserPanel(window, host, dir, url);
  } finally {
    await service.shutdown();
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Electron holds its profile open until app.exit; the test runner removes this afterward.
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
