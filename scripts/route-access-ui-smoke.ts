import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-route-login-ui-'));
  const folder = join(root, 'workspace');
  await mkdir(folder);
  const api = await startApiServer(0, {
    dataDir: join(root, 'data'),
    webDir: resolve('dist/web'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish: string | null) =>
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'route-ui-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-chat',
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          '\n\n',
      );
    send({ role: 'assistant', content: 'Hi from the existing bot!' }, null);
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    const configured = await fetch(api.url + '/api/providers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local route UI fixture',
        kind: 'compatible',
        baseUrl: 'http://127.0.0.1:' + (provider.address() as { port: number }).port + '/v1',
        defaultModel: 'test-chat',
        models: [
          {
            id: 'test-chat',
            name: 'Test chat',
            contextWindowTokens: 65536,
            maxOutputTokens: 1024,
            supportsImages: false,
          },
        ],
        supportsImages: false,
        isDefault: true,
        apiKey: 'dummy-route-ui-test-key',
      }),
    });
    assert(configured.ok, await configured.text());
    seedTestBot(api.store);
    api.workspaces.update('default', { name: 'Route login QA', folder });
    const reference = await readFile(
      resolve('src/skills/mukai-custom-routes-authenticated-websites/references/bot-api.md'),
      'utf8',
    );
    const example = reference.match(/```js\n([\s\S]*?)\n```/)?.[1];
    assert(example, 'Missing direct-fetch skill example.');
    const html =
      '<!doctype html><title>Owner dashboard</title><h1>Protected dashboard</h1><button id="hello">Say hi</button><output id="reply"></output><script>' +
      example +
      `
      document.getElementById('hello').onclick=async function(){
        this.disabled=true;
        try { const reply=await sayHi('scout'); document.getElementById('reply').textContent=reply.content; }
        catch(error){document.getElementById('reply').textContent=error.message;}
        finally{this.disabled=false;}
      };` +
      '</script>';
    await writeFile(
      join(folder, 'ui.ts'),
      `export default {
        name:'owner_ui', method:'GET', path:'/custom/owner-ui', auth:'session',
        handle(){ return ${JSON.stringify({ status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public,max-age=3600' }, body: html })}; }
      };`,
    );
    await api.capabilities.manage('default', null, 'route', {
      operation: 'register',
      modulePath: 'ui.ts',
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const destination = api.url + '/custom/owner-ui?ticket=2';
    await page.goto(destination);
    await page.getByRole('heading', { name: 'Connect your Mukai.', exact: true }).waitFor();
    assert(page.url().includes('mukai-returnTo='));
    await page
      .getByRole('textbox', { name: 'Setup code', exact: true })
      .fill(api.ownerAuth!.setupCode);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill('a test-only secure passphrase');
    await page
      .getByLabel('Confirm password', { exact: true })
      .fill('a test-only secure passphrase');
    await page.getByRole('button', { name: 'Create login & open Mukai', exact: true }).click();
    await page.getByRole('heading', { name: 'Protected dashboard', exact: true }).waitFor();
    assert.equal(page.url(), destination);
    const botCount = Number(
      api.store.get('SELECT COUNT(*) AS total FROM bots WHERE workspace_id=?', 'default')!.total,
    );
    const sent = page.waitForResponse(
      (response) =>
        response.url() === api.url + '/api/bots/scout/chat' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Say hi', exact: true }).click();
    assert.equal((await sent).status(), 200);
    await page.getByText('Hi from the existing bot!', { exact: true }).waitFor();
    assert.equal(
      Number(
        api.store.get('SELECT COUNT(*) AS total FROM bots WHERE workspace_id=?', 'default')!.total,
      ),
      botCount,
    );
    assert.equal(
      Number(
        api.store.get(
          "SELECT COUNT(*) AS total FROM messages WHERE bot_id=? AND role='user' AND content=?",
          'scout',
          'hi',
        )!.total,
      ),
      1,
    );
    assert.deepEqual(
      api.capabilities
        .list('default')
        .map((route) => ({ kind: route.kind, method: route.definition.method })),
      [{ kind: 'route', method: 'GET' }],
    );
    const cached = await page.request.get(destination);
    assert.equal(cached.headers()['cache-control'], 'no-store');
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error('Logout failed');
      return (await fetch('/custom/owner-ui')).status;
    });
    assert.equal(status, 401);
    await page.goto(destination);
    await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill('a test-only secure passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Protected dashboard', exact: true }).waitFor();
    assert.equal(page.url(), destination);
    const fresh = await browser.newPage();
    const unauthenticated = await fresh.request.get(destination, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(unauthenticated.status(), 401);
    await mkdir('artifacts/route-access', { recursive: true });
    await page.screenshot({ path: 'artifacts/route-access/owner-dashboard.png' });
    assert.deepEqual(errors, []);
    console.log(
      'Single session GET page, direct browser-to-bot API call, login return, logout and no-store passed.',
    );
  } finally {
    await browser?.close();
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
