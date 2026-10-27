import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import type { Bot, ProviderSettings, Workspace } from '../src/shared/ai';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-reasoning-ui-'));
  const calls: Record<string, unknown>[] = [];
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'reasoning-ui',
          created: 1,
          model: 'reasoner',
          choices: [
            { index: 0, delta: { content: 'Effort request completed.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
  const api = await startApiServer(0, {
    dataDir: join(root, 'data'),
    webDir: resolve('dist/web'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  async function request<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
    const response = await fetch(api.url + '/api' + path, {
      method,
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
    return data as T;
  }
  try {
    await mkdir(join(root, 'workspace'));
    const workspace = await request<Workspace>('/workspaces', 'POST', {
      name: 'Reasoning QA',
      folder: join(root, 'workspace'),
      computer: 'local',
    });
    const provider = await request<ProviderSettings>('/providers', 'POST', {
      name: 'Local reasoning fixture',
      kind: 'compatible',
      baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
      defaultModel: 'reasoner',
      supportsImages: false,
      isDefault: true,
      models: [
        {
          id: 'reasoner',
          name: 'Reasoner',
          contextWindowTokens: 128000,
          maxOutputTokens: 8192,
          supportsImages: false,
          reasoningEffort: 'high',
          customReasoning: { supportedEfforts: ['low', 'high', 'max'] },
        },
        {
          id: 'plain',
          name: 'Plain model',
          contextWindowTokens: 128000,
          maxOutputTokens: 8192,
          supportsImages: false,
          reasoningEffort: 'provider-default',
        },
      ],
    });
    const bot = await request<Bot>('/bots', 'POST', {
      workspaceId: workspace.id,
      name: 'Reasoning QA',
      role: 'Assistant',
      instructions: 'Reply briefly.',
      providerId: provider.id,
      model: 'reasoner',
      supportsImages: null,
      avatar: 'atlas',
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 980 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    const effort = page.getByRole('button', {
      name: 'Reasoning effort for Reasoning QA',
      exact: true,
    });
    await effort.filter({ hasText: 'Inherit · High' }).waitFor();
    await effort.click();
    assert.equal(await page.getByRole('menuitemradio', { name: 'Off', exact: true }).count(), 0);
    await page.getByRole('menuitemradio', { name: 'Maximum', exact: true }).click();
    await effort.filter({ hasText: 'Maximum' }).waitFor();
    assert.equal(
      (await request<Bot[]>('/bots?workspaceId=' + workspace.id))[0].reasoningEffort,
      'max',
    );
    const composer = page.locator('.ai-composer-area textarea');
    await composer.fill('Verify maximum effort.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page
      .locator('.ai-message--assistant')
      .filter({ hasText: 'Effort request completed.' })
      .waitFor();
    assert.equal(calls[0].reasoning_effort, 'max');
    await page.reload();
    await effort.filter({ hasText: 'Maximum' }).waitFor();
    await page.getByRole('button', { name: 'Choose model for Reasoning QA', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Plain model', exact: true }).click();
    await effort.filter({ hasText: 'Inherit · Provider default' }).waitFor();
    assert.equal(
      (await request<Bot[]>('/bots?workspaceId=' + workspace.id))[0].reasoningEffort,
      null,
    );
    await effort.click();
    assert.equal(await page.getByRole('menuitemradio', { name: 'High', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Choose model for Reasoning QA', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Reasoner', exact: true }).click();
    await effort.filter({ hasText: 'Inherit · High' }).waitFor();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Providers', exact: true }).click();
    await page.getByRole('button', { name: 'Configure models', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Reasoner', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit model', exact: true });
    await editor.getByRole('combobox', { name: 'Default reasoning effort', exact: true }).click();
    await page.getByRole('option', { name: 'Low', exact: true }).click();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/reasoning-model-settings.png' });
    await editor.getByRole('button', { name: 'Save model', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(
      (await request<ProviderSettings[]>('/providers'))[0].models?.[0].reasoningEffort,
      'low',
    );
    await page.reload();
    await effort.filter({ hasText: 'Inherit · Low' }).waitFor();
    await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'ocean' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.setViewportSize({ width: 720, height: 900 });
    await effort.click();
    await page.screenshot({ path: 'artifacts/reasoning-picker-narrow.png' });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
    assert.equal(bot.model, 'reasoner');
    console.log(
      'PASS reasoning UI: model defaults, bot overrides, exact request effort, reload persistence, model-switch reset, capability filtering, settings save, and narrow layout.',
    );
  } finally {
    await browser?.close();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
    fixture.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
    assert.ok(root.startsWith(join(tmpdir(), 'mukai-reasoning-ui-')));
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
