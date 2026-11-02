import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import type { AIActivity, AIWork, AIMemoryPressure } from '../src/shared/aiActivity';

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
      function Chat({title,id}){return <section style={{minWidth:0,border:'1px solid var(--line)'}}>
        <header style={{padding:'16px 20px',borderBottom:'1px solid var(--line)',fontWeight:600}}>{title}</header>
        <div className="ai-message-feed queue-smoke-feed" style={{height:330,flex:'none'}}>
          {Array.from({length:12},(_,i)=><article className="ai-message" key={i}><div className="ai-message-body"><div className="ai-message-meta"><strong>{i%2?'Mukai':'You'}</strong></div><p>{i%2?'I’ll check the export and verify the files.':'Please review the latest export.'}</p></div></article>)}
          <AIQueueNotice conversationId={id}/>
        </div>
      </section>}
      function App(){const[settings,setSettings]=useState(false);return <AIQueueSettings.Provider value={()=>setSettings(true)}><main style={{maxWidth:880,margin:'30px auto',padding:12}}>{settings?<LimitsPanel/>:<><h2>Main chat</h2><Chat title="Mukai" id="main"/><h2>Pursuit chat</h2><Chat title="Review the export" id="pursuit"/></>}</main></AIQueueSettings.Provider>};createRoot(document.getElementById('root')).render(<App/>);`,
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
    assert.match(await page.locator('.ai-queue-notice').first().innerText(), /Queued.*#1/s);
    assert.match(await page.locator('.ai-queue-notice').nth(1).innerText(), /#2/);
    assert.match(await page.locator('.ai-queue-notice').first().innerText(), /4\/4 slots busy/);
    assert.equal(
      await page.locator('.ai-queue-notice').first().locator('.ai-queue-workspaces > span').count(),
      3,
    );
    assert.match(await page.locator('.ai-queue-notice').first().innerText(), /Content \(2\)/);
    const feeds = page.locator('.queue-smoke-feed');
    await feeds.evaluateAll((items) =>
      items.forEach((item) => {
        item.scrollTop = item.scrollHeight;
      }),
    );
    const feedBox = (await feeds.first().boundingBox())!;
    const noticeBox = (await page.locator('.ai-queue-notice').first().boundingBox())!;
    assert(noticeBox.y + noticeBox.height <= feedBox.y + feedBox.height + 1);
    // The notice follows the latest message and scrolls out of view with it.
    await feeds.first().evaluate((item) => {
      item.scrollTop = 0;
    });
    assert(
      (await page.locator('.ai-queue-notice').first().boundingBox())!.y >
        feedBox.y + feedBox.height,
    );
    await feeds.first().evaluate((item) => {
      item.scrollTop = item.scrollHeight;
    });
    await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await feeds.evaluateAll((items) =>
      items.forEach((item) => {
        item.scrollTop = item.scrollHeight;
      }),
    );
    assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
    await page.getByRole('link', { name: 'Change limits in Settings' }).first().click();
    await page.locator('#ai-concurrency:not([disabled])').waitFor();
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.screenshot({ path: join(output, 'limits-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, 'limits-mobile.png'), fullPage: true });
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
    const pressure: AIMemoryPressure = {
      providerId: 'omlx',
      providerName: 'oMLX',
      effectiveLimit: 1,
      configuredLimit: 6,
      cooldownUntil: new Date(Date.now() + 30000).toISOString(),
    };
    activity.memoryPressure = [pressure];
    activity.queued[0] = {
      ...activity.queued[0],
      providerId: 'omlx',
      memoryPressure: pressure,
      memoryRetry: { attempt: 1, maxAttempts: 3, phase: 'retry' },
    };
    await page.reload();
    await page.getByText('Waiting for memory recovery').waitFor();
    assert.match(
      await page.locator('.ai-queue-notice').first().innerText(),
      /Retry in \d+s.*Retry 1\/3/s,
    );
    assert.match(
      await page.locator('.ai-queue-notice').first().innerText(),
      /temporarily allows 1 AI; your saved maximum is 6/,
    );
    const countdown = await page
      .locator('.ai-queue-notice')
      .first()
      .locator('.ai-queue-heading > span')
      .innerText();
    await page.waitForFunction(
      (previous) =>
        document.querySelector('.ai-queue-heading > span')?.textContent?.trim() !== previous,
      countdown,
    );
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.locator('.queue-smoke-feed').evaluateAll((items) =>
      items.forEach((item) => {
        item.scrollTop = item.scrollHeight;
      }),
    );
    await page.screenshot({ path: join(output, 'memory-recovery-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.queue-smoke-feed').evaluateAll((items) =>
      items.forEach((item) => {
        item.scrollTop = item.scrollHeight;
      }),
    );
    assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await page.screenshot({ path: join(output, 'memory-recovery-mobile.png'), fullPage: true });
    delete pressure.cooldownUntil;
    activity.running.push(activity.queued.shift()!);
    await page.getByText('Retrying after memory rejection').waitFor();
    activity.running.at(-1)!.memoryRetry!.phase = 'compaction';
    await page.getByText('Trying a smaller context').waitFor();
    await page.getByRole('link', { name: 'Change limits in Settings' }).first().click();
    await page.locator('#ai-concurrency:not([disabled])').waitFor();
    assert.equal(await page.locator('#ai-concurrency').inputValue(), '6');
    await page.getByText(/Memory recovery: oMLX temporarily allows 1 AI/).waitFor();
    activity.memoryPressure = [];
    await page.getByText(/Memory recovery: oMLX/).waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log(
      'PASS AI queue UI: inline bottom notices scroll with messages; positions, running workspaces, settings links, limits, cooldown countdowns, retry/compaction explanations and mobile layout.',
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
