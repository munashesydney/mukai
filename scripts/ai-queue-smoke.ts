import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import type { AIActivity, AIWork } from '../src/shared/aiActivity';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-ai-queue-ui-'));
  const output = resolve('artifacts/ai-queue');
  await mkdir(output, { recursive: true });
  const task = (
    id: string,
    workspaceName: string,
    kind: AIWork['kind'],
    conversationId?: string,
  ): AIWork => ({
    id,
    workspaceId: workspaceName,
    workspaceName,
    kind,
    conversationId,
    queuedAt: new Date().toISOString(),
  });
  const activity: AIActivity = {
    limit: 4,
    running: [
      task('one', 'Content', 'chat'),
      task('two', 'Content', 'memory'),
      task('three', 'Mukai', 'compaction'),
      task('four', 'Experiments', 'pursuit'),
    ],
    queued: [task('five', 'Main', 'chat', 'main'), task('six', 'Main', 'pursuit', 'pursuit')],
  };
  let limits = { aiConcurrency: 4, pursuitConcurrency: 5 };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/api/ai-activity' || path === '/api/limits') {
      if (req.method === 'PUT') {
        let text = '';
        for await (const chunk of req) text += chunk;
        limits = JSON.parse(text);
        activity.limit = limits.aiConcurrency;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(path.endsWith('limits') ? limits : activity));
      return;
    }
    if (path === '/app.js' || path === '/app.css') {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(join(directory, path.slice(1))));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><html data-mode="dark" data-theme="mukai"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="background:var(--surface);color:var(--ink)"><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
    );
  });
  let browser: Browser | undefined;
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{AIQueueNotice}from'./src/renderer/src/features/ai/AIQueueNotice';
      import{AIQueueSettings}from'./src/renderer/src/features/ai/aiQueueContext';
      import{LimitsPanel}from'./src/renderer/src/features/settings/LimitsPanel';
      import './src/renderer/src/styles/tokens.css';import './src/renderer/src/styles/global.css';import './src/renderer/src/styles/ai.css';import './src/renderer/src/styles/appearance.css';
      function App(){const[settings,setSettings]=useState(false);return <AIQueueSettings.Provider value={()=>setSettings(true)}><main style={{maxWidth:760,margin:'30px auto',padding:12}}>{settings?<LimitsPanel/>:<><h2>Main chat</h2><AIQueueNotice conversationId="main"/><h2>Pursuit chat</h2><AIQueueNotice conversationId="pursuit"/></>}</main></AIQueueSettings.Provider>};createRoot(document.getElementById('root')).render(<App/>);`,
      },
      bundle: true,
      format: 'esm',
      define: { 'import.meta.env.DEV': 'false' },
      outfile: join(directory, 'app.js'),
      platform: 'browser',
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(url);
    await page.locator('.ai-queue-notice').nth(1).waitFor();
    assert.match(
      await page.locator('.ai-queue-notice').first().innerText(),
      /Queued for AI.*Position 1/s,
    );
    assert.match(await page.locator('.ai-queue-notice').nth(1).innerText(), /Position 2/);
    assert.match(await page.locator('.ai-queue-notice').first().innerText(), /4 of 4 AI slots/);
    assert.equal(
      await page.locator('.ai-queue-notice').first().locator('.ai-queue-workspaces > span').count(),
      3,
    );
    assert.match(await page.locator('.ai-queue-notice').first().innerText(), /Content\s+2/);
    await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
    await page.getByRole('link', { name: 'Change limits in Settings' }).first().click();
    await page.locator('#ai-concurrency:not([disabled])').waitFor();
    assert.equal(await page.locator('#ai-concurrency').inputValue(), '4');
    await page.locator('#ai-concurrency').fill('0');
    assert.equal(
      await page.getByRole('button', { name: 'Save limit', exact: true }).isDisabled(),
      true,
    );
    await page.locator('#ai-concurrency').fill('6');
    await page.locator('#pursuit-concurrency').fill('3');
    await page.getByRole('button', { name: 'Save limit', exact: true }).click();
    await page.getByText('Saved. The shared schedulers now use these limits.').waitFor();
    assert.deepEqual(limits, { aiConcurrency: 6, pursuitConcurrency: 3 });
    await page.reload();
    await page.locator('.ai-queue-notice').first().waitFor();
    await page.getByRole('link', { name: 'Change limits in Settings' }).nth(1).click();
    await page.locator('#ai-concurrency:not([disabled])').waitFor();
    assert.equal(await page.locator('#ai-concurrency').inputValue(), '6');
    assert.deepEqual(errors, []);
    console.log(
      'PASS AI queue UI: main/pursuit queues, positions, active workspaces, settings links, limit validation/save, and mobile layout.',
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
