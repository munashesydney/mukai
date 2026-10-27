import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright-core';

function removePreviewDirectory(directory: string) {
  if (!resolve(directory).startsWith(resolve(tmpdir(), 'mukai-delegation-preview-')))
    throw new Error('Unexpected temporary preview directory.');
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'mukai-delegation-preview-'));
  const output = resolve('artifacts/delegation-ui');
  let browser: Browser | undefined;
  const publicRoot = resolve('src/renderer/public');
  mkdirSync(output, { recursive: true });
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
      const activities=['Ada','Iris','Nova'].map((name,index)=>({id:'send-'+index,tool:'manage_bot',action:'send_message',path:name,status:'complete',summary:'Work dispatched.',delegation:{botId:name,botName:name,avatar:['muka-mascot-1-purple','muka-mascot-2-green','muka-mascot-4-blue'][index],conversationId:'pair-'+index,requestId:'child-'+index,mode:'fire_and_forget',status:'streaming'}}));
      const initial={id:'parent',botId:'scout',requestId:'request',role:'assistant',status:'streaming',content:'I’m checking the implementation and gathering the independent reviews.',error:null,createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),attachments:[],activity:[...activities,{id:'waiting',tool:'manage_bot',action:'wait_for_bots',path:'',status:'running',summary:'Waiting for delegated bots.'}],parts:[{id:'progress',type:'text',text:'I’m checking the implementation and gathering the independent reviews.'},...activities.map(a=>({id:a.id,type:'tool',activityId:a.id})),{id:'wait',type:'tool',activityId:'waiting'}]};
      function Preview(){const [message,setMessage]=useState(initial);
        useEffect(()=>{window.delegationPreview={complete(index){setMessage(previous=>{const source=previous.activity.find(a=>a.id==='send-'+index);const reply={...source,id:'reply-'+index,action:'receive_message',status:'complete',summary:source.delegation.botName+' finished the review.\\n\\nThe implementation looks good. The important edge cases have been checked.',delegation:{...source.delegation,status:'complete'}};return {...previous,activity:[...previous.activity.map(a=>a.id===source.id?{...a,delegation:{...a.delegation,status:'complete'}}:a),reply],parts:[...previous.parts,{id:reply.id,type:'tool',activityId:reply.id}]};});}};},[]);
        return <main className="response-preview ai-message-body"><header><strong>Scout</strong><span>BOT</span><small>Implementation review</small></header><ResponseActivity message={message}/></main>;
      }
      createRoot(document.getElementById('root')).render(<Preview/>);
    `,
    },
    bundle: true,
    platform: 'browser',
    outfile: join(directory, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/page.css"><style>body{margin:0;padding:48px;background:var(--navy);color:var(--ink);font:14px system-ui}.response-preview{max-width:750px;margin:auto}header{display:flex;align-items:center;gap:12px;margin-bottom:24px}header strong{font-size:18px}header span{font-size:10px;color:var(--teal)}header small{margin-left:auto;color:var(--text-muted)}</style></head><body><div id="root"></div><script src="/page.js"></script></body></html>`;
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(html);
      return;
    }
    const local =
      path === '/page.js' || path === '/page.css'
        ? join(directory, path.slice(1))
        : resolve(publicRoot, '.' + decodeURIComponent(path));
    if (!local.startsWith(publicRoot + sep) && !local.startsWith(directory + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        'Content-Type',
        path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.webp')
              ? 'image/webp'
              : path.endsWith('.svg')
                ? 'image/svg+xml'
                : 'image/png',
      );
      response.end(readFileSync(local));
    } catch {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.waitForFunction(
      'Boolean(window.delegationPreview)&&document.querySelectorAll(".spawned-bot").length===3',
    );
    await page.waitForFunction(
      'Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)',
    );
    const leftEdge = (await page.locator('.spawned-bot').first().boundingBox())!.x;
    assert.equal(
      await page
        .locator('.spawned-bots')
        .evaluate((element) => getComputedStyle(element).justifyContent),
      'flex-start',
    );
    assert.equal(
      await page
        .locator('.spawned-bot')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundImage),
      'none',
    );
    await page.screenshot({ path: join(output, 'working.png') });
    await page.evaluate('window.delegationPreview.complete(0)');
    await page.waitForFunction('document.querySelectorAll(".spawned-bot--returning").length===1');
    assert(
      await page.evaluate(
        'document.querySelector(".spawned-bot--returning").getAnimations().length>0',
      ),
    );
    const frames = await page.locator('.spawned-bot--returning').evaluate((element) => {
      const effect = element.getAnimations()[0].effect as KeyframeEffect;
      return { frames: effect.getKeyframes(), duration: effect.getTiming().duration };
    });
    assert.equal(frames.duration, 280);
    assert.equal(frames.frames.at(-1)!.transform, 'translateY(-28px)');
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(output, 'returning.png') });
    await page.waitForFunction('document.querySelectorAll(".spawned-bot").length===2');
    assert.equal((await page.locator('.spawned-bot').first().boundingBox())!.x, leftEdge);
    assert.equal(await page.locator('.response-tool--reply').count(), 1);
    assert.equal(
      await page
        .locator('.response-tool--reply')
        .evaluate((element) => element.parentElement!.className),
      'response-transcript',
    );
    await page.screenshot({ path: join(output, 'partial-results.png') });
    await page.locator('.response-tool--reply > summary').click();
    assert(
      await page
        .locator('.response-tool--reply')
        .evaluate((element) => (element as HTMLDetailsElement).open),
    );
    await page.screenshot({ path: join(output, 'received.png') });
    await page.evaluate(
      'window.delegationPreview.complete(1);window.delegationPreview.complete(2)',
    );
    await page.waitForFunction(
      'document.querySelectorAll(".spawned-bot").length===0&&document.querySelectorAll(".response-tool--reply").length===3',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(
      'Boolean(window.delegationPreview)&&document.querySelectorAll(".spawned-bot").length===3',
    );
    assert(await page.evaluate('window.matchMedia("(prefers-reduced-motion: reduce)").matches'));
    await page.evaluate('window.delegationPreview.complete(0)');
    await page.waitForFunction('document.querySelectorAll(".spawned-bot").length===2');
    await page.setViewportSize({ width: 440, height: 720 });
    assert(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
    assert.deepEqual(errors, []);
    console.log(
      'Delegation UI passed: typing cards, actual return animation, expandable reply, multiple children, reduced motion, narrow layout.',
    );
    console.log('Screenshots: ' + output);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    removePreviewDirectory(directory);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
