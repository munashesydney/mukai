import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startApiServer } from '../src/server/app';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-api-settings-ui-'));
  const folder = join(root, 'workspace');
  await mkdir(folder);
  const api = await startApiServer(0, { dataDir: join(root, 'data'), webDir: resolve('dist/web') });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
    const workspaceResponse = await fetch(api.url + '/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'API settings test', folder }),
    });
    assert.equal(workspaceResponse.status, 201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const botResponse = await fetch(api.url + '/api/bots', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: 'Scout',
        role: 'Main Bot/Orchestrator',
        instructions: 'You are Scout, a helpful companion for this isolated UI test.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'mukai-logo',
      }),
    });
    assert.equal(botResponse.status, 201);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1280, height: 900 },
    });
    const verify = await context.request.post(api.url + '/api/auth/verify', {
      headers: { Origin: api.url },
      data: { code: api.ownerAuth!.setupCode },
    });
    assert.equal(verify.status(), 200);
    const setup = await context.request.post(api.url + '/api/auth/setup', {
      headers: { Origin: api.url },
      data: { username: 'owner', password: 'isolated API settings fixture' },
    });
    assert.equal(setup.status(), 200);
    const page = await context.newPage();
    let tokenReads = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/settings/api') tokenReads++;
    });
    await page.goto(api.url);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('tab', { name: 'API', exact: true }).click();
    const token = page.getByLabel('Mukai token', { exact: true });
    const url = page.getByLabel('Base URL', { exact: true });
    await url.waitFor();
    await page.waitForFunction(() =>
      Boolean((document.querySelector('#mukai-api-base-url') as HTMLInputElement)?.value),
    );
    assert.equal(await url.inputValue(), api.url);
    assert.equal(await token.getAttribute('type'), 'password');
    assert.equal(tokenReads, 0, 'Opening settings must not fetch the token.');
    assert.ok(
      !(await page.content()).includes(api.token),
      'The real token must not be mounted while hidden.',
    );
    await page.getByRole('button', { name: 'Copy token', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Mukai token copied.' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), api.token);
    assert.equal(await token.getAttribute('type'), 'password');
    assert.ok(!(await page.content()).includes(api.token), 'Copy must not reveal the token.');
    await page.getByRole('button', { name: 'Reveal token', exact: true }).click();
    await page.getByRole('button', { name: 'Hide token', exact: true }).waitFor();
    assert.equal(await token.inputValue(), api.token);
    await page.getByRole('button', { name: 'Hide token', exact: true }).click();
    assert.equal(await token.getAttribute('type'), 'password');
    assert.ok(!(await page.content()).includes(api.token));
    await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Base URL copied.' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), api.url);
    await page.route('**/api/settings/api', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary API settings failure.' }),
      }),
    );
    await page.getByRole('button', { name: 'Copy token', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Temporary API settings failure.' }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      api.url,
      'A failed read must leave the clipboard unchanged.',
    );
    assert.equal(await token.getAttribute('type'), 'password');
    console.log(
      'API settings: hidden by default, authenticated reveal/copy, URL copy and error handling passed.',
    );
  } finally {
    await browser?.close();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
