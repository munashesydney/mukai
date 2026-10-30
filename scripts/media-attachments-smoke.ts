import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
            {
              index: 0,
              delta: {
                content:
                  'Media request completed.\n\n[Play audio](recording.wav) · [Play video](preview.webm) · [Read PDF](sample.pdf) · [Unsupported video](broken.mp4)',
              },
              finish_reason: 'stop',
            },
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
    const video = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#12232e';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise<void>((done) => (recorder.onstop = () => done()));
      recorder.start();
      for (let frame = 0; frame < 6; frame++) {
        drawing.fillStyle = frame % 2 ? '#369b82' : '#12232e';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        await new Promise((done) => setTimeout(done, 100));
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    await Promise.all([
      writeFile(join(project, 'recording.wav'), wavFixture()),
      writeFile(join(project, 'preview.webm'), Buffer.from(video)),
      writeFile(join(project, 'broken.mp4'), mp4Fixture()),
      writeFile(
        join(project, 'sample.pdf'),
        '%PDF-1.1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF',
      ),
    ]);
    const input = page.getByLabel('Upload chat attachments');
    await input.waitFor({ state: 'attached' });
    const composer = page.locator('.ai-composer-area textarea');
    async function selectModel(name: string) {
      await page.getByRole('button', { name: /Choose model for/ }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).waitFor({ state: 'hidden' });
      assert(
        (await page.getByRole('button', { name: /Choose model for/ }).innerText()).includes(name),
      );
    }
    let uploads = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/attachments')) uploads++;
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoQAAAAASUVORK5CYII=',
      'base64',
    );
    const transferred = [
      { name: 'dropped.png', type: 'image/png', bytes: [...png] },
      { name: 'pasted.wav', type: 'audio/wav', bytes: [...wavFixture()] },
      { name: 'pasted.mp4', type: 'video/mp4', bytes: [...mp4Fixture()] },
      { name: 'pasted.txt', type: 'text/plain', bytes: [...Buffer.from('Clipboard notes')] },
    ];
    async function transfer(
      action: 'drop' | 'paste' | 'dragenter' | 'dragleave',
      files = transferred,
    ) {
      return page.evaluate(
        ({ action, files }) => {
          const data = new DataTransfer();
          for (const file of files)
            data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
          const event =
            action === 'paste'
              ? new ClipboardEvent(action, { bubbles: true, cancelable: true, clipboardData: data })
              : new DragEvent(action, { bubbles: true, cancelable: true, dataTransfer: data });
          document
            .querySelector(
              action === 'paste' ? '.ai-composer-area textarea' : '.ai-composer-area .composer',
            )!
            .dispatchEvent(event);
          return event.defaultPrevented;
        },
        { action, files },
      );
    }
    await composer.fill('Keep my draft.');
    assert(await transfer('dragenter', transferred.slice(0, 1)));
    await page.locator('.composer.is-dragging-files').waitFor();
    assert(await transfer('dragleave', transferred.slice(0, 1)));
    await page.locator('.composer.is-dragging-files').waitFor({ state: 'hidden' });
    assert(await transfer('drop', transferred.slice(0, 1)));
    await page.getByRole('button', { name: 'Remove dropped.png', exact: true }).waitFor();
    assert(await transfer('paste', transferred.slice(1)));
    await page.getByRole('button', { name: 'Remove pasted.txt', exact: true }).waitFor();
    assert.equal(await page.locator('.ai-pending-attachments .ai-attachment').count(), 4);
    assert.equal(await composer.inputValue(), 'Keep my draft.');
    assert.equal(uploads, 4);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/composer-dropped-pasted-media.png' });
    for (const file of transferred) {
      await page.getByRole('button', { name: `Remove ${file.name}`, exact: true }).click();
      await page
        .getByRole('button', { name: `Remove ${file.name}`, exact: true })
        .waitFor({ state: 'hidden' });
    }
    await selectModel('Text model');
    for (const file of transferred.slice(0, 3)) {
      for (const action of ['drop', 'paste'] as const) {
        assert(await transfer(action, [file]));
        await page
          .getByRole('alert')
          .filter({ hasText: /does not support .* input/ })
          .waitFor();
        assert.equal(await page.locator('.ai-pending-attachments .ai-attachment').count(), 0);
        assert.equal(uploads, 4, 'Unsupported media must be rejected before upload.');
      }
    }
    await input.setInputFiles({ name: 'blocked.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() });
    await page.getByRole('alert').filter({ hasText: 'does not support video input' }).waitFor();
    assert.equal(uploads, 4, 'The picker must enforce the same restriction as paste and drop.');
    await selectModel('Media model');
    await page
      .getByRole('alert')
      .filter({ hasText: /does not support .* input/ })
      .waitFor({ state: 'hidden' });
    await selectModel('Text model');
    // Text pastes still use the browser's normal keyboard handling.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('Normal clipboard text'));
    await composer.fill('');
    await composer.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('.ai-composer-area textarea')?.value ===
        'Normal clipboard text',
    );
    assert(await transfer('paste', transferred.slice(3)));
    await page.getByRole('button', { name: 'Remove pasted.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove pasted.txt', exact: true }).click();
    await page
      .getByRole('button', { name: 'Remove pasted.txt', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(uploads, 5, 'Text documents remain available to text-only models.');
    assert.deepEqual(errors, []);
    if (process.argv.includes('--composer-only')) {
      console.log(
        'PASS composer transfers: image drop, audio/video/document paste, drag feedback, retained draft, native text paste, and unsupported media rejected before upload across picker/paste/drop.',
      );
      return;
    }
    await selectModel('Media model');
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
    await composer.fill('Compare these recordings.');
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
    await page.getByRole('button', { name: 'Play audio', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.waitForFunction(
      () => (document.querySelector<HTMLAudioElement>('dialog audio')?.readyState || 0) >= 1,
    );
    assert(await dialog.locator('audio').evaluate((audio: HTMLAudioElement) => audio.controls));
    assert(await dialog.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.autoplay));
    await dialog.locator('audio').evaluate((audio: HTMLAudioElement) => audio.play());
    await page.waitForFunction(
      () => document.querySelector<HTMLAudioElement>('dialog audio')?.ended,
    );
    await page.screenshot({ path: 'artifacts/media-preview-audio.png' });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Play video', exact: true }).click();
    try {
      await page.waitForFunction(
        () => (document.querySelector<HTMLVideoElement>('dialog video')?.readyState || 0) >= 1,
      );
    } catch (error) {
      console.error(
        'Video preview state:',
        await dialog.locator('video').evaluate((video: HTMLVideoElement) => ({
          readyState: video.readyState,
          networkState: video.networkState,
          error: video.error?.message,
          duration: video.duration,
          source: video.currentSrc,
        })),
      );
      await page.screenshot({ path: 'artifacts/media-preview-failure.png' });
      throw error;
    }
    assert(await dialog.locator('video').evaluate((element: HTMLVideoElement) => element.controls));
    await dialog.locator('video').evaluate((element: HTMLVideoElement) => element.play());
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>('dialog video')?.ended,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: 'artifacts/media-preview-video-mobile.png' });
    await page.setViewportSize({ width: 1480, height: 980 });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Unsupported video', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'could not be played here' }).waitFor();
    assert(await dialog.getByRole('link', { name: 'Download', exact: true }).isVisible());
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Read PDF', exact: true }).click();
    const openPdf = dialog.getByRole('link', { name: 'Open in browser' });
    await openPdf.waitFor();
    const pdfUrl = await openPdf.getAttribute('href');
    assert(pdfUrl?.startsWith('blob:'));
    const popup = page.waitForEvent('popup');
    await openPdf.click();
    const pdfTab = await popup;
    await pdfTab.waitForURL('blob:**');
    assert(pdfTab.url().startsWith('blob:'));
    await pdfTab.close();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
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
      'PASS media attachments UI: audio/video playback, unsupported-codec fallback, PDF browser tab, mobile preview, capability-aware picker, retained uploads, SDK media delivery, and historical media fallback.',
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
