/** Real noVNC + TigerVNC text clipboard checks in a disposable VM and headless Chrome. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import { build } from 'esbuild';
import { z } from 'zod';
import { QemuComputer, type QemuConfig } from '../src/server/computer/qemuComputer';
import { DesktopTransport } from '../src/server/computer/desktopTransport';
import { defaultDataDir } from '../src/server/config';

async function main() {
  const index = process.argv.indexOf('--data-dir');
  const dataDir = index < 0 ? defaultDataDir() : resolve(process.argv[index + 1]);
  const config = JSON.parse(
    await readFile(join(dataDir, 'computer-setup/ready.json'), 'utf8'),
  ) as QemuConfig;
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mukai-clipboard-vm-'));
  await mkdir('artifacts', { recursive: true });
  const fixture = await mkdtemp(resolve('artifacts/clipboard-ui-'));
  const vm = new QemuComputer(directory, config, undefined, resolve('dist/guest'));
  const transport = new DesktopTransport(true);
  const owner = { workspaceId: basename(directory), botId: 'smoke', conversationId: 'clipboard' };
  const signal = AbortSignal.timeout(300000);
  const request = (method: Parameters<QemuComputer['request']>[0], input: unknown) =>
    vm.request(method, input, owner, signal);
  const assets = new Map<string, { content: Uint8Array; type: string }>();
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/workspaces/') && req.url.endsWith('/computer-view')) {
      void transport
        .session(vm)
        .then((session) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(session));
        })
        .catch((failure: Error) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: failure.message }));
        });
    } else if (req.url?.startsWith('/api/workspaces/') && req.url.endsWith('/computer')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(vm.status()));
    } else {
      const asset = assets.get(req.url || '/');
      res.statusCode = asset ? 200 : 404;
      if (asset) res.setHeader('Content-Type', asset.type);
      res.end(asset?.content);
    }
  });
  transport.attach(server);
  let browser: Browser | undefined;
  let guestTab = '';
  const snapshot = async () =>
    z
      .object({
        controls: z.array(z.object({ ref: z.string(), role: z.string(), value: z.string() })),
      })
      .parse(await request('browser', { action: 'snapshot', sessionId: guestTab })).controls;
  const eventually = async (check: () => Promise<boolean>, message: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await check()) return;
      await delay(150, undefined, { signal });
    }
    throw new Error(message);
  };
  const hasText = async (text: string) =>
    (await snapshot()).some((control) => control.role === 'textarea' && control.value === text);
  try {
    console.log('Booting disposable clipboard VM:', directory);
    let previousStatus = '';
    const progress = setInterval(() => {
      const status = vm.status();
      const message = status.message || status.state;
      if (message !== previousStatus) {
        console.log('VM:', message);
        previousStatus = message;
      }
    }, 5000);
    const abort = () => {
      void vm.stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await vm.start();
    } finally {
      clearInterval(progress);
      signal.removeEventListener('abort', abort);
    }
    console.log('Guest ready. Opening a real browser textarea.');
    await request('files', {
      action: 'write_file',
      path: 'clipboard-smoke.html',
      content:
        '<!doctype html><title>Clipboard smoke</title><textarea aria-label="Clipboard input" autofocus style="width:90vw;height:60vh;font-size:24px"></textarea>',
    });
    await request('terminal', {
      command: 'python3 -m http.server 8898 --bind 127.0.0.1',
      background: true,
    });
    await delay(500);
    guestTab = z.object({ tab: z.object({ id: z.string() }) }).parse(
      await request('browser', {
        action: 'open',
        target: 'chrome',
        url: 'http://127.0.0.1:8898/clipboard-smoke.html',
      }),
    ).tab.id;
    await request('browser', { action: 'screenshot', sessionId: guestTab });
    const textarea = (await snapshot()).find((control) => control.role === 'textarea');
    assert.ok(textarea);
    await request('browser', { action: 'click', sessionId: guestTab, ref: textarea.ref });
    const bundle = await build({
      stdin: {
        contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ComputerPanel} from './src/renderer/src/features/computer/ComputerPanel';
      import './src/renderer/src/styles/tokens.css'; import './src/renderer/src/styles/global.css'; import './src/renderer/src/styles/computer.css';
      createRoot(document.getElementById('root')).render(<div style={{display:'flex',height:'100vh'}}><ComputerPanel workspaceId="smoke" open onClose={()=>{}} /></div>);
    `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: join(fixture, 'main.js'),
      format: 'esm',
      define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
    });
    for (const file of bundle.outputFiles)
      assets.set('/' + basename(file.path), {
        content: file.contents,
        type: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    assets.set('/', {
      type: 'text/html',
      content: new TextEncoder().encode(
        '<!doctype html><link rel="stylesheet" href="/main.css"><div id="root"></div><script type="module" src="/main.js"></script>',
      ),
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error('Viewer error:', error.message);
    });
    await page.goto(origin);
    try {
      await page.getByText('Live', { exact: true }).waitFor({ timeout: 30000 });
    } catch (failure) {
      await page.screenshot({ path: resolve('artifacts/clipboard-failure.png') });
      console.error('Viewer state:', await page.locator('body').innerText());
      throw failure;
    }
    const canvas = page.locator('.computer-canvas canvas');
    // Windows clipboard text uses CRLF even when written with LF.
    const hostText = async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    const sample = 'Mukai café 世界 🌱\nA second line — Ω';
    await page.evaluate((text) => navigator.clipboard.writeText(text), sample);
    await canvas.focus();
    await page.keyboard.press('Control+v');
    await eventually(() => hasText(sample), 'Host-to-VM Unicode paste did not arrive in Chrome.');
    console.log('PASS: host-to-VM Unicode/multiline paste');

    await page.evaluate(() => navigator.clipboard.writeText('host sentinel'));
    await page.keyboard.press('Control+a');
    await delay(150);
    await page.keyboard.press('Control+c');
    try {
      await eventually(
        async () => (await hostText()) === sample,
        'VM copy did not reach the host clipboard.',
      );
    } catch (failure) {
      console.error(
        'Host focus:',
        await page.evaluate(() => ({
          focused: document.hasFocus(),
          active: document.activeElement?.tagName,
        })),
      );
      console.error(
        'Guest snapshot:',
        await request('browser', { action: 'snapshot', sessionId: guestTab }),
      );
      await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
      console.error(
        'Received clipboard:',
        await page.getByLabel('From VM', { exact: true }).inputValue(),
      );
      console.error('Viewer state:', await page.locator('body').innerText());
      await page.screenshot({ path: resolve('artifacts/clipboard-failure.png') });
      throw failure;
    }
    console.log('PASS: VM-to-host copy');

    await page.evaluate(() => navigator.clipboard.writeText('held modifier'));
    await page.keyboard.down('ControlRight');
    await page.keyboard.press('v');
    await eventually(() => hasText('held modifier'), 'Paste with right Control held failed.');
    await page.keyboard.press('a');
    await page.keyboard.up('ControlRight');
    await page.keyboard.type('after held control');
    await eventually(
      () => hasText('after held control'),
      'The next shortcut lost held Control after paste.',
    );
    console.log('PASS: held right Control is preserved for subsequent shortcuts');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await eventually(
      async () => (await hostText()) === 'after held control',
      'Fresh VM text did not replace the host clipboard.',
    );
    console.log('PASS: copying new text produced inside the VM');

    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
    await page.getByLabel('To VM', { exact: true }).fill(sample);
    await page.getByRole('button', { name: 'Paste into VM', exact: true }).click();
    await eventually(() => hasText(sample), 'Manual paste did not arrive.');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await eventually(
      async () => (await page.getByLabel('From VM', { exact: true }).inputValue()) === sample,
      'Manual panel did not receive VM clipboard.',
    );
    await page.evaluate(() => navigator.clipboard.writeText('manual sentinel'));
    await page.getByRole('button', { name: 'Copy from VM', exact: true }).click();
    assert.equal(await hostText(), sample);
    await page.screenshot({ path: resolve('artifacts/clipboard-panel.png') });
    console.log('PASS: manual panel in both directions');

    // A string keeps tsx's function-name helper out of this nested page function.
    await page.evaluate(
      "Object.defineProperty(navigator.clipboard, 'readText', { configurable: true, value: () => Promise.reject(new Error('Clipboard permission denied')) })",
    );
    await canvas.focus();
    await page.keyboard.press('Control+v');
    await page.getByRole('status').filter({ hasText: 'Open Clipboard' }).waitFor();
    assert.ok(await hasText(sample), 'Denied host read pasted stale text.');
    await page.evaluate(() => {
      delete (navigator.clipboard as Partial<Clipboard>).readText;
    });
    console.log('PASS: denied permission leaves guest contents intact and offers fallback');

    await request('files', {
      action: 'write_file',
      path: 'clipboard-terminal.py',
      content:
        'import os,sys,tty\ntty.setraw(sys.stdin.fileno())\nwith open("/home/mukai/workspace/clipboard-terminal.txt","wb",buffering=0) as f:\n while True: f.write(os.read(sys.stdin.fileno(),65536))\n',
    });
    const terminal = z.object({ id: z.string() }).parse(
      await request('terminal', {
        command:
          "xfce4-terminal --disable-server --geometry=80x24+0+0 --title Clipboard-smoke-terminal --command 'python3 /home/mukai/workspace/clipboard-terminal.py'",
        background: true,
      }),
    );
    await eventually(async () => {
      try {
        await request('files', { action: 'read_file', path: 'clipboard-terminal.txt' });
        return true;
      } catch {
        return false;
      }
    }, 'Terminal input receiver did not start.');
    const terminalText = 'Terminal café 世界 🌱';
    await page.evaluate((text) => navigator.clipboard.writeText(text), terminalText);
    // Explicit geometry and a real click avoid window-manager focus-stealing prevention.
    await canvas.click({ position: { x: 120, y: 140 } });
    await page.keyboard.press('Control+Shift+v');
    try {
      await eventually(async () => {
        try {
          const result = z
            .object({ result: z.object({ content: z.string() }) })
            .parse(await request('files', { action: 'read_file', path: 'clipboard-terminal.txt' }));
          return (
            result.result.content === terminalText ||
            result.result.content === terminalText.replace(/\n/g, '\r')
          );
        } catch {
          return false;
        }
      }, 'Ctrl+Shift+V did not reach the real terminal.');
    } catch (failure) {
      await page.screenshot({ path: resolve('artifacts/clipboard-terminal-failure.png') });
      console.error(
        'Terminal process:',
        await request('process', { action: 'poll', sessionId: terminal.id }),
      );
      console.error(
        'Terminal contents:',
        await request('files', { action: 'read_file', path: 'clipboard-terminal.txt' }),
      );
      throw failure;
    }
    console.log('PASS: Ctrl+Shift+V in the real terminal');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    transport.shutdown();
    await new Promise<void>((done) => server.close(() => done()));
    await vm.stop();
    // Both directories are newly-created smoke fixtures; never target user workspace disks.
    assert.ok(basename(directory).startsWith('mukai-clipboard-vm-'));
    assert.ok(
      fixture.startsWith(resolve('artifacts') + '\\') ||
        fixture.startsWith(resolve('artifacts') + '/'),
    );
    await rm(directory, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}
void main().catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
