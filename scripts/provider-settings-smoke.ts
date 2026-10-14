import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import type { Bot, ProviderSettings } from '../src/shared/ai';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-provider-ui-'));
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
    const project = join(root, 'project');
    await mkdir(project);
    const workspace = await request<{ id: string }>('/workspaces', 'POST', {
      name: 'Provider QA',
      folder: project,
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 980 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    async function capture(name: string) {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({ path: `artifacts/${name}.png` });
    }
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('tab', { name: 'Providers', exact: true }).click();
    const panel = page.locator('.provider-panel');
    await page.getByRole('button', { name: 'Add DeepSeek', exact: true }).waitFor();
    assert.equal(
      (await request<ProviderSettings[]>('/providers')).length,
      0,
      'Presets must not create unauthenticated provider records.',
    );
    await mkdir('artifacts', { recursive: true });
    await capture('providers-catalog-light');
    // Every requested provider opens with its documented endpoint and model catalog.
    for (const [name, url, count] of [
      ['Z.ai / GLM', 'https://api.z.ai/api/paas/v4', 3],
      ['Xiaomi MiMo', 'https://api.xiaomimimo.com/v1', 2],
      ['Qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 2],
      ['Kimi', 'https://api.moonshot.ai/v1', 4],
    ] as const) {
      await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
      assert.equal(await panel.getByLabel('Base URL').inputValue(), url);
      assert.ok(
        await panel
          .getByText(
            `${count} models included with researched limits. You can customize them after saving.`,
            { exact: true },
          )
          .isVisible(),
      );
      await panel.getByRole('button', { name: 'All providers', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Add DeepSeek', exact: true }).click();
    assert.equal(await panel.getByLabel('Base URL').inputValue(), 'https://api.deepseek.com');
    await panel.getByLabel('API key').fill('disposable-ui-test-key');
    await capture('providers-connection-light');
    await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
    await panel.getByRole('heading', { name: 'DeepSeek models', exact: true }).waitFor();
    assert.equal(
      await panel.getByRole('button', { name: 'Save connection', exact: true }).count(),
      0,
    );
    const provider = (await request<ProviderSettings[]>('/providers'))[0];
    assert.equal(provider.models?.length, 2);
    assert.equal(provider.contextWindowTokens, 1000000);
    const encrypted = api.store.get(
      'SELECT encrypted_key FROM providers WHERE id=?',
      provider.id,
    )?.encrypted_key;
    await panel.getByRole('button', { name: 'Add model', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Add model', exact: true });
    assert.equal(await sheet.getByLabel('Context window (tokens)').inputValue(), '128000');
    assert.equal(await sheet.getByLabel('Maximum output (tokens)').inputValue(), '32768');
    await sheet.getByLabel('Model ID', { exact: true }).fill('custom-qa');
    await sheet.getByLabel('Display name', { exact: true }).fill('QA model');
    await sheet.getByRole('button', { name: 'Save model', exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
    let updated = (await request<ProviderSettings[]>('/providers'))[0];
    assert.equal(updated.models?.length, 3, 'Saving a model must persist without Save connection.');
    await panel.getByRole('button', { name: 'Edit QA model', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit model', exact: true });
    await editor.getByLabel('Context window (tokens)').fill('131072');
    await editor.getByLabel('Maximum output (tokens)').fill('16384');
    await editor.getByLabel('Supports images').check();
    // A failed write retains the editor and draft; retry persists the same values.
    await page.route('**/api/providers/*/models', async (route) => {
      if (route.request().method() === 'PUT')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary model save failure' }),
        });
      else await route.continue();
    });
    await editor.getByRole('button', { name: 'Save model', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: 'Temporary model save failure' }).waitFor();
    assert.equal(await editor.getByLabel('Context window (tokens)').inputValue(), '131072');
    assert.equal(
      (await request<ProviderSettings[]>('/providers'))[0].models?.find(
        (model) => model.id === 'custom-qa',
      )?.contextWindowTokens,
      128000,
    );
    await capture('providers-model-save-error');
    await page.unroute('**/api/providers/*/models');
    await editor.getByRole('button', { name: 'Save model', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await panel.getByRole('combobox', { name: 'Default model', exact: true }).click();
    await page.getByRole('option', { name: 'QA model', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Model settings saved.' }).waitFor();
    updated = (await request<ProviderSettings[]>('/providers'))[0];
    assert.equal(updated.defaultModel, 'custom-qa');
    assert.equal(updated.contextWindowTokens, 131072);
    assert.equal(updated.maxOutputTokens, 16384);
    assert.equal(updated.supportsImages, true);
    assert.equal(
      api.store.get('SELECT encrypted_key FROM providers WHERE id=?', provider.id)?.encrypted_key,
      encrypted,
    );
    await capture('providers-models-light');
    // Reload persistence and a real dedicated models view.
    await page.reload();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('tab', { name: 'Providers', exact: true }).click();
    await panel.getByRole('button', { name: 'Configure models', exact: true }).click();
    await panel.getByRole('button', { name: 'Edit QA model', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Connection settings', exact: true }).click();
    await panel.getByLabel('Display name', { exact: true }).fill('DeepSeek work');
    assert.equal(
      await panel.getByRole('button', { name: 'Test connection', exact: true }).isDisabled(),
      true,
    );
    await panel.getByRole('button', { name: 'Configure models', exact: true }).click();
    await panel.getByRole('group', { name: 'Unsaved connection changes', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await panel.getByRole('heading', { name: 'DeepSeek work models', exact: true }).waitFor();
    updated = (await request<ProviderSettings[]>('/providers'))[0];
    assert.equal(updated.name, 'DeepSeek work');
    assert.equal(updated.models?.length, 3);
    assert.equal(updated.hasKey, true);
    await panel.getByRole('button', { name: 'Remove QA model', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove model', exact: true }).click();
    await panel
      .getByRole('button', { name: 'Remove QA model', exact: true })
      .waitFor({ state: 'hidden' });
    updated = (await request<ProviderSettings[]>('/providers'))[0];
    assert.equal(updated.defaultModel, 'deepseek-flash');
    assert.equal(updated.models?.length, 2);
    // Narrow and dark layouts retain the app theme and avoid horizontal overflow.
    await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'ocean' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');
    await capture('providers-models-dark');
    await page.setViewportSize({ width: 720, height: 900 });
    await capture('providers-models-narrow');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.setViewportSize({ width: 1480, height: 980 });
    await panel.getByRole('button', { name: 'All providers', exact: true }).click();
    await capture('providers-list-dark');
    // Deletion preserves bots: explicit assignments block it with a useful message.
    const bot = await request<Bot>('/bots', 'POST', {
      workspaceId: workspace.id,
      name: 'QA',
      role: 'QA specialist',
      instructions: 'Verify behavior.',
      providerId: provider.id,
      model: 'deepseek-flash',
      supportsImages: null,
      avatar: 'atlas',
    });
    await panel.getByRole('button', { name: 'Delete DeepSeek work', exact: true }).click();
    await panel.getByRole('button', { name: 'Delete provider', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'A bot uses this provider' }).waitFor();
    assert.equal((await request<ProviderSettings[]>('/providers')).length, 1);
    await request(`/bots/${bot.id}/model`, 'PUT', {
      providerId: null,
      model: null,
      supportsImages: null,
    });
    await panel.getByRole('button', { name: 'Delete provider', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Provider deleted.' }).waitFor();
    assert.equal((await request<ProviderSettings[]>('/providers')).length, 0);
    await page.getByRole('button', { name: 'Add Qwen', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'PASS providers UI: official presets, immediate model persistence, retry after save failure, defaults, credentials, navigation, reload, light/dark/narrow layouts, and provider deletion.',
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
