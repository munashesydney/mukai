// Run with run-computer-smoke.ts: a disposable Electron profile and cloned VM disk.
import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { Workspace, Bot } from '../src/shared/ai';
import { z } from 'zod';

async function main() {
  const directory = process.env.MUKAI_COMPUTER_SMOKE_DIR;
  if (!directory) throw new Error('Disposable smoke directory required.');
  app.setPath('userData', directory);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const api = await startApiServer(0, {
    dataDir: join(directory, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  const window = new BrowserWindow({
    show: false,
    width: 1480,
    height: 900,
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
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer:', event.message);
  });
  const until = async (check: () => Promise<boolean>, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Timed out waiting for smoke check.');
  };
  const request = async <T>(path: string, body: unknown) => {
    const response = await fetch(api.url + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return (await response.json()) as T;
  };
  const fixture = createServer((_request, response) =>
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        '<title>Mukai live computer</title><style>body{font:20px sans-serif;padding:60px;background:#eef4f2;color:#28463d}input{padding:14px;font:inherit;width:300px}</style><h1>Your computer, live.</h1><p>This Chrome window is running inside the Linux VM.</p><label>Desktop input <input autofocus /></label>',
      ),
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const workspace = await request<Workspace>('/workspaces', {
      name: 'VM desktop acceptance',
      computer: 'qemu',
    });
    await request<Bot>('/bots', {
      workspaceId: workspace.id,
      name: 'Mukai',
      role: 'Assistant',
      instructions: 'Help with work.',
      providerId: null,
      model: null,
      supportsImages: null,
      avatar: 'nova',
    });
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await evaluate(
      `localStorage.setItem('mukai.active-workspace', ${JSON.stringify(workspace.id)});`,
    );
    await window.reload();
    await until(() => evaluate('Boolean(document.querySelector(".composer textarea"))'));
    await evaluate(
      `(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Preserve this draft');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.computer-toggle').click();})()`,
    );
    const vm = api.computers.guest(workspace);
    const progress = setInterval(() => {
      console.log(vm.status().message || vm.status().state);
      void evaluate(
        'document.querySelector(".computer-placeholder")?.textContent || document.querySelector(".computer-status")?.textContent',
      ).then((state) => console.log('Viewer:', state));
    }, 15000);
    try {
      await until(async () => {
        const state = await evaluate<string>(
          'document.querySelector(".computer-status")?.textContent',
        );
        if (state === 'Disconnected')
          throw new Error(
            await evaluate<string>('document.querySelector(".computer-placeholder")?.textContent'),
          );
        return state === 'Live';
      }, 1200000);
    } finally {
      clearInterval(progress);
    }
    console.log('Connected to live desktop.');
    const owner = { workspaceId: workspace.id, botId: 'acceptance', conversationId: 'acceptance' };
    const signal = new AbortController().signal;
    const command = async (command: string) => {
      const schema = z.object({
        id: z.string(),
        status: z.string(),
        output: z.string(),
        exitCode: z.number().nullable(),
      });
      let result = schema.parse(
        await vm.request('terminal', { command, yieldMs: 1000 }, owner, signal),
      );
      while (result.status === 'running')
        result = schema.parse(
          await vm.request(
            'process',
            { action: 'wait', sessionId: result.id, waitMs: 30000 },
            owner,
            signal,
          ),
        );
      assert.equal(result.exitCode, 0, result.output);
      return result.output;
    };
    const checkSize = async () => {
      const size = await evaluate<{ width: number; height: number; chat: number; total: number }>(
        '(()=>{const display=document.querySelector(".computer-canvas");return {width:display.clientWidth,height:display.clientHeight,chat:document.querySelector(".workspace-content").getBoundingClientRect().width,total:document.querySelector(".app-body").clientWidth};})()',
      );
      assert.ok(Math.abs(size.chat / size.total - 0.25) < 0.002, JSON.stringify(size));
      let observed = '';
      try {
        await until(async () => {
          observed = await command('xdpyinfo | grep dimensions:');
          return observed.includes(`${size.width}x${size.height}`);
        });
      } catch (error) {
        console.error(
          'Expected panel:',
          size,
          'Guest:',
          observed,
          'Canvas:',
          await evaluate(
            '(()=>{const canvas=document.querySelector(".computer-canvas canvas");return {width:canvas.width,height:canvas.height,rect:canvas.getBoundingClientRect().toJSON()};})()',
          ),
        );
        throw error;
      }
      assert.equal(
        await evaluate(
          'document.querySelector(".workspace-navigation").getBoundingClientRect().width',
        ),
        0,
      );
    };
    await checkSize();
    await evaluate('document.querySelector(".computer-controls button").click()');
    window.setSize(1200, 820);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await checkSize();
    await evaluate('document.querySelector(".computer-controls button").click()');
    window.setSize(1480, 900);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await checkSize();
    console.log('Verified exact 25/75 split and guest resolution matching the panel.');
    const page = z.object({ tab: z.object({ id: z.string() }) }).parse(
      await vm.request(
        'browser',
        {
          action: 'open',
          url: `http://10.0.2.2:${(fixture.address() as { port: number }).port}/`,
        },
        owner,
        signal,
      ),
    );
    const snapshot = z
      .object({ controls: z.array(z.object({ ref: z.string(), name: z.string() })) })
      .parse(
        await vm.request('browser', { action: 'snapshot', sessionId: page.tab.id }, owner, signal),
      );
    const input = snapshot.controls.find((control) => control.name.includes('Desktop input'))!;
    assert.ok(input);
    await vm.request(
      'browser',
      { action: 'click', sessionId: page.tab.id, ref: input.ref },
      owner,
      signal,
    );
    await evaluate('document.querySelector(".computer-canvas canvas").focus()');
    for (const keyCode of ['h', 'i']) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }
    await until(async () =>
      JSON.stringify(
        await vm.request('browser', { action: 'snapshot', sessionId: page.tab.id }, owner, signal),
      ).includes('"value":"hi"'),
    );
    mkdirSync('artifacts', { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    writeFileSync('artifacts/computer-view.png', (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".computer-toggle").click()');
    await until(() => evaluate('!document.querySelector(".computer-panel.is-open")'));
    assert.equal(
      await evaluate('document.querySelector(".composer textarea").value'),
      'Preserve this draft',
    );
    assert.equal(vm.status().state, 'running');
    await evaluate('document.querySelector(".computer-toggle").click()');
    await until(() => evaluate('Boolean(document.querySelector(".computer-status.is-connected"))'));
    await checkSize();
    console.log(
      'Verified guest keyboard input, chat draft preservation, and viewer reconnect without stopping the VM.',
    );
  } finally {
    window.destroy();
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
void main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
