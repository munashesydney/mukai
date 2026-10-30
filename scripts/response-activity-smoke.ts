import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { ChatActivity, ChatMessage, ResponsePart } from '../src/shared/ai';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-response-ui-'));
  const output = resolve('artifacts/response-activity');
  await mkdir(output, { recursive: true });
  const initial: ChatMessage = {
    id: 'response',
    botId: 'scout',
    conversationId: 'preview',
    requestId: 'request',
    role: 'assistant',
    status: 'streaming',
    content: '',
    error: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    parts: [],
    activity: [],
  };
  let browser: Browser | undefined;
  let terminalRequests = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (path.includes('/terminal')) {
      terminalRequests++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(terminal));
    } else if (path === '/preview.js' || path === '/preview.css') {
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(await readFile(join(directory, path.slice(1))));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html><html data-mode="dark" data-theme="mukai"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>body{margin:0;padding:32px;min-height:100vh;background:var(--surface);color:var(--ink);font:14px/1.6 system-ui}main{max-width:760px;margin:auto;min-width:0}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>`,
      );
    }
  });
  const terminal = {
    id: '68db9142-e774-4bdf-bbdb-1b95219dd12a',
    command: 'npm test',
    cwd: '/workspace',
    status: 'running' as const,
    exitCode: null,
    createdAt: initial.createdAt,
    output: 'Running activity regression checks…',
  };
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
        import React, {useEffect,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ResponseActivity} from './src/renderer/src/features/ai/ResponseActivity';
        import './src/renderer/src/styles/tokens.css';
        import './src/renderer/src/styles/global.css';
        import './src/renderer/src/styles/ai.css';
        function Preview(){
          const [message,setMessage]=useState(${JSON.stringify(initial)});
          useEffect(()=>{window.responsePreview={set:setMessage};},[]);
          return <main className="ai-message-body"><ResponseActivity message={message}/></main>;
        }
        createRoot(document.getElementById('root')).render(<Preview/>);
      `,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'preview.js'),
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.waitForFunction('Boolean(window.responsePreview)');
    const set = async (message: ChatMessage) => {
      await page.evaluate(
        (value) =>
          (
            window as unknown as {
              responsePreview: { set: (message: ChatMessage) => void };
            }
          ).responsePreview.set(value),
        message,
      );
    };
    assert.equal(await page.locator('.typing-dots').count(), 0);
    assert.match(
      await page.locator('.response-tool-group-label.is-working').innerText(),
      /Thinking/,
    );
    assert.match(await page.locator('.response-work > summary').innerText(), /^Working for /);
    assert.equal(await page.locator('.response-work > summary .response-shimmer').count(), 0);
    const intro: ResponsePart = {
      id: 'intro',
      type: 'text',
      text: 'I’ll check the activity view and its tests.',
    };
    const read = (index: number, running = false): ChatActivity => ({
      id: `read-${index}`,
      tool: 'file_operations',
      action: 'read_file',
      path: index ? `src/check-${index}.ts` : 'src/useChatActivity.ts',
      status: running ? 'running' : 'complete',
      summary: 'Read file contents.',
    });
    const toolPart = (activity: ChatActivity): ResponsePart => ({
      id: `part-${activity.id}`,
      type: 'tool',
      activityId: activity.id,
    });
    const first = read(0, true);
    const initialGroup = page.locator('.response-tool-group');
    await initialGroup.locator(':scope > summary').click();
    await set({ ...initial, parts: [toolPart(first)], activity: [first] });
    await initialGroup
      .locator(':scope > summary')
      .filter({ hasText: 'Reading useChatActivity.ts' })
      .waitFor();
    assert.equal(
      await initialGroup.evaluate((element) => (element as HTMLDetailsElement).open),
      true,
      'The pending Thinking row must become the first tool group without resetting its disclosure.',
    );
    await set({ ...initial, parts: [intro, toolPart(first)], activity: [first] });
    const groups = page.locator('.response-tool-group');
    const firstGroup = groups.first();
    const title = firstGroup.locator(':scope > summary');
    await title.filter({ hasText: 'Reading useChatActivity.ts' }).waitFor();
    assert.equal(
      await firstGroup.evaluate((element) => (element as HTMLDetailsElement).open),
      false,
    );
    assert.equal(
      await firstGroup
        .locator('.response-tool-group-label')
        .evaluate((element) => getComputedStyle(element).animationName),
      'response-text-shimmer',
    );
    await page.screenshot({ path: join(output, 'working-collapsed-dark.png') });
    await title.focus();
    await title.press('Enter');
    await page.waitForFunction('document.querySelector(".response-tool-group").open');
    const activities: ChatActivity[] = Array.from({ length: 20 }, (_, index) => read(index));
    activities.push({
      id: 'command',
      tool: 'terminal',
      action: 'run',
      path: 'npm test',
      status: 'complete',
      summary: '',
      terminal,
      processSessionId: terminal.id,
    });
    activities.push({ ...read(21, true), path: 'src/useChatActivity.ts' });
    const work: ResponsePart[] = activities.flatMap((activity, index) => [
      toolPart(activity),
      { id: `separator-${index}`, type: 'text' as const, text: '\n\n' },
    ]);
    work.splice(1, 0, {
      id: 'reasoning',
      type: 'reasoning',
      text: 'Checking coverage.',
      state: 'complete',
    });
    let message: ChatMessage = { ...initial, parts: [intro, ...work], activity: activities };
    await set(message);
    await firstGroup
      .locator('.response-tool')
      .filter({ hasText: 'check-19.ts' })
      .waitFor({ state: 'attached' });
    assert.equal(
      await groups.count(),
      1,
      'Terminals and reasoning must stay in the same tool loop.',
    );
    assert.equal(
      await firstGroup.evaluate((element) => (element as HTMLDetailsElement).open),
      true,
      'New tool calls must preserve a manual expansion.',
    );
    const content = firstGroup.locator('.response-tool-group-content');
    const bounds = await content.evaluate((element) => ({
      height: element.clientHeight,
      total: element.scrollHeight,
    }));
    assert(
      bounds.height <= 280 && bounds.total > bounds.height,
      'Expanded tools must have a bounded scrollbar.',
    );
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    assert(await content.evaluate((element) => element.scrollTop > 0));
    assert(
      (await firstGroup.locator('.response-tool > summary').first().boundingBox())!.height <= 24,
      'Tool rows should use compact spacing.',
    );
    const command = firstGroup.locator('.terminal-card');
    assert.equal(await command.locator('.terminal-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await command.locator('.terminal-panel').count(), 0);
    assert.equal(terminalRequests, 0, 'Collapsed terminal calls must not fetch historical output.');
    await command.locator('.terminal-toggle').click();
    await command.locator('.terminal-transcript').filter({ hasText: terminal.output }).waitFor();
    await command.locator('.terminal-toggle').click();
    assert(terminalRequests > 0, 'Opening a terminal call must fetch live output.');
    const requestsWhenClosed = terminalRequests;
    await page.waitForTimeout(1200);
    assert.equal(terminalRequests, requestsWhenClosed, 'Closing a terminal must stop its poller.');
    await page.screenshot({ path: join(output, 'working-expanded-dark.png') });
    const patch: ChatActivity = {
      id: 'patch',
      tool: 'file_operations',
      action: 'patch',
      path: 'src/ResponseActivity.tsx',
      status: 'running',
      summary: '',
    };
    message = {
      ...message,
      activity: [
        ...activities.map((activity) => ({ ...activity, status: 'complete' as const })),
        patch,
      ],
      parts: [
        ...message.parts!,
        {
          id: 'update',
          type: 'text',
          text: 'The reads are complete. I’m updating the activity layout.',
        },
        toolPart(patch),
      ],
    };
    await set(message);
    await groups
      .nth(1)
      .locator(':scope > summary')
      .filter({ hasText: 'Editing ResponseActivity.tsx' })
      .waitFor();
    assert.match(await title.innerText(), /Read files, ran commands/);
    assert.equal(await firstGroup.locator('.is-working').count(), 0);
    assert.equal(
      await groups.nth(1).evaluate((element) => (element as HTMLDetailsElement).open),
      false,
    );
    await title.click();
    await page.screenshot({ path: join(output, 'two-groups-dark.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await page
        .locator('.is-working')
        .evaluate((element) => getComputedStyle(element).animationName),
      'none',
    );
    assert.notEqual(
      await page
        .locator('.is-working')
        .evaluate((element) => getComputedStyle(element).webkitTextFillColor),
      'transparent',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(output, 'working-mobile.png') });
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'light';
    });
    await page.screenshot({ path: join(output, 'working-light.png') });
    await groups.nth(1).locator(':scope > summary').click();
    await set({
      ...message,
      status: 'complete',
      finishedAt: new Date().toISOString(),
      activity: message.activity!.map((activity) => ({ ...activity, status: 'complete' })),
      parts: [
        ...message.parts!,
        { id: 'final', type: 'text', text: 'The activity layout is ready.', final: true },
      ],
    });
    await page.getByText('The activity layout is ready.', { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('.response-work')
        .evaluate((element) => (element as HTMLDetailsElement).open),
      false,
    );
    assert.equal(await page.locator('.response-shimmer, .is-working').count(), 0);
    await page.locator('.response-work > summary').click();
    assert(
      await groups.evaluateAll((elements) =>
        elements.every((element) => !(element as HTMLDetailsElement).open),
      ),
      'Completion must reset manually expanded inner groups too.',
    );
    await page.locator('.response-work > summary').click();
    await page.screenshot({ path: join(output, 'completed.png') });
    const media: ChatActivity[] = [
      read(0),
      ...Array.from({ length: 3 }, (_, index): ChatActivity => ({
        id: `view-${index}`,
        tool: 'media',
        action: 'view_image',
        path: `preview-${index}.png`,
        status: 'complete',
        summary: 'Viewed image.',
      })),
      {
        id: 'after-images',
        tool: 'terminal',
        action: 'run',
        path: 'npm test',
        status: 'complete',
        summary: 'Tests passed.',
      },
      ...Array.from({ length: 2 }, (_, index): ChatActivity => ({
        id: `listen-${index}`,
        tool: 'media',
        action: 'listen_audio',
        path: `audio-${index}.wav`,
        status: 'complete',
        summary: 'Listened to audio.',
      })),
      {
        id: 'video',
        tool: 'media',
        action: 'view_video',
        path: 'demo.mp4',
        status: 'complete',
        summary: 'Viewed video.',
      },
      { ...read(1, true), id: 'resume-read' },
    ];
    await set({
      ...initial,
      id: 'media-preview',
      activity: media,
      parts: [intro, ...media.map(toolPart)],
    });
    await page
      .locator('.response-tool-group-label')
      .filter({ hasText: 'Viewed 3 images' })
      .waitFor();
    assert.deepEqual(await page.locator('.response-tool-group-label').allTextContents(), [
      'Read files',
      'Viewed 3 images',
      'Ran commands',
      'Listened to 2 audio clips',
      'Viewed 1 video',
      'Reading check-1.ts',
    ]);
    assert.match(await page.locator('.response-work > summary').innerText(), /^Working for /);
    const images = page
      .locator('.response-tool-group')
      .filter({ has: page.locator(':scope > summary', { hasText: 'Viewed 3 images' }) });
    await images.locator(':scope > summary').click();
    assert.equal(await images.locator('.response-tool-image:visible').count(), 3);
    await images.locator(':scope > summary').click();
    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'dark';
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.screenshot({ path: join(output, 'separate-media-groups.png') });
    // A real long-running conversation can have hundreds of saved sessions.
    // Opening its history or a tool group must not start a poller per session.
    const historical: ChatActivity[] = Array.from({ length: 200 }, (_, index) => ({
      id: `historical-${index}`,
      tool: 'terminal',
      action: 'run',
      path: `command-${index}`,
      status: 'complete',
      summary: '',
      terminal: { ...terminal, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
    }));
    const beforeHistory = terminalRequests;
    await set({
      ...initial,
      id: 'history',
      status: 'complete',
      activity: historical,
      parts: [
        ...historical.map(toolPart),
        { id: 'historical-answer', type: 'text', text: 'Historical work is saved.', final: true },
      ],
    });
    await page.getByText('Historical work is saved.', { exact: true }).waitFor();
    await page.locator('.response-work > summary').click();
    await page.locator('.response-tool-group > summary').click();
    assert.equal(await page.locator('.terminal-card').count(), 200);
    await page.waitForTimeout(1200);
    assert.equal(
      terminalRequests,
      beforeHistory,
      'Saved terminal history must not create a request burst.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS response activity UI: stable Working timer, pending Thinking transition, separate image/audio/video groups, grouped loops, whitespace separators, shimmer, keyboard disclosure, bounded scroll, compact rows, terminal click-to-expand, quiet 200-session history, reduced motion, narrow layout, and final collapse.',
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
