import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import type { ProviderSettings } from '../src/shared/ai';
import { wavFixture, mp4Fixture } from '../src/server/testMediaFixtures';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-media-ui-'));
  const calls: unknown[] = [];
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'media-ui',
          created: 1,
          model: 'media',
          choices: [
            { index: 0, delta: { content: 'Media request completed.' }, finish_reason: 'stop' },
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
    assert(response.ok, JSON.stringify(data));
    return data as T;
  }
  try {
    const project = join(root, 'project');
    await mkdir(project);
    const workspace = await request<{ id: string }>('/workspaces', 'POST', {
      name: 'Media QA',
      folder: project,
    });
    const models = [
      {
        id: 'media',
        name: 'Media model',
        contextWindowTokens: 262144,
        maxOutputTokens: 4096,
        supportsImages: true,
        supportsAudio: true,
        supportsVideo: true,
      },
      {
        id: 'text',
        name: 'Text model',
        contextWindowTokens: 262144,
        maxOutputTokens: 4096,
        supportsImages: false,
        supportsAudio: false,
        supportsVideo: false,
      },
    ];
    const provider = await request<ProviderSettings>('/providers', 'POST', {
      name: 'Local media fixture',
      kind: 'compatible',
      baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
      defaultModel: 'media',
      models,
      supportsImages: true,
      isDefault: true,
    });
    await request('/bots', 'POST', {
      workspaceId: workspace.id,
      name: 'Media QA',
      role: 'Assistant',
      instructions: 'Review the user’s attachments.',
      providerId: provider.id,
      model: 'media',
      supportsImages: null,
      avatar: 'atlas',
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 980 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    const input = page.getByLabel('Upload chat attachments');
    await input.waitFor({ state: 'attached' });
    assert((await input.getAttribute('accept'))?.includes('.wav,.mp3'));
    assert((await input.getAttribute('accept'))?.includes('.mp4,.mov'));
    await input.setInputFiles([
      { name: 'recording.wav', mimeType: 'audio/wav', buffer: wavFixture() },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() },
    ]);
    await page
      .locator('.ai-composer-area .ai-attachment')
      .filter({ hasText: 'recording.wav' })
      .waitFor();
    await page
      .locator('.ai-composer-area .ai-attachment')
      .filter({ hasText: 'clip.mp4' })
      .waitFor();
    const composer = page.locator('.ai-composer-area textarea');
    await composer.fill('Compare these recordings.');
    async function selectModel(name: string) {
      await page.getByRole('button', { name: /Choose model for/ }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
    }
    await selectModel('Text model');
    await page
      .getByRole('alert')
      .filter({ hasText: 'does not support audio, video input' })
      .waitFor();
    assert(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled());
    assert(!(await input.getAttribute('accept'))?.includes('.wav'));
    assert.equal(calls.length, 0);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/media-attachments-blocked.png' });
    await selectModel('Media model');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Media request completed.', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'Stop generation', exact: true })
      .waitFor({ state: 'hidden' });
    assert(JSON.stringify(calls.at(-1)).includes('input_audio'));
    assert(JSON.stringify(calls.at(-1)).includes('video_url'));
    await selectModel('Text model');
    await composer.fill('Continue after switching to text only.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Media request completed.', { exact: true }).nth(1).waitFor();
    await page
      .getByRole('button', { name: 'Stop generation', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(calls.length, 2);
    const latest = JSON.stringify(calls.at(-1));
    assert(latest.includes('does not support audio input'));
    assert(latest.includes('does not support video input'));
    assert(!latest.includes('input_audio'));
    assert(!latest.includes('video_url'));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'artifacts/media-attachments-chat.png' });
    console.log(
      'PASS media attachments UI: capability-aware picker, pending media blocked after model switch, retained uploads, real SDK media delivery, and safe historical media fallback.',
    );
  } finally {
    await browser?.close();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
    fixture.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
