import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Locator } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';
import { wavFixture, mp4Fixture } from '../src/server/testMediaFixtures';
import sharp from 'sharp';

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mukai-steering-ui-'));
  let continueWork = false;
  const inputs: string[] = [];
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    inputs.push(JSON.stringify(input.messages));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (content: string, finish: string | null = null, reasoning?: string) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'ui-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [
            { index: 0, delta: { content, reasoning_content: reasoning }, finish_reason: finish },
          ],
        })}\n\n`,
      );
    send('', null, 'Checking the layout before making changes.');
    send('I am reviewing the existing layout. ');
    if (continueWork) {
      send('I continued using your correction.', 'stop');
      response.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
  const api = await startApiServer(0, {
    dataDir: dir,
    memoryExtractor: async () => ({ facts: [] }),
  });
  const vite = await createViteServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [process.cwd()] },
      proxy: {
        '/api': {
          target: api.url,
          rewrite: (path) => path.replace(/^\/api/, ''),
          configure: (proxy) =>
            proxy.on('proxyReq', (request) => {
              request.setHeader('Authorization', 'Bearer ' + api.token);
              request.removeHeader('origin');
            }),
        },
      },
    },
  });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    seedTestBot(api.store);
    const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
    const provider = await fetch(api.url + '/providers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'UI fixture',
        kind: 'compatible',
        baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
        defaultModel: 'fixture',
        models: [
          {
            id: 'fixture',
            name: 'UI fixture',
            contextWindowTokens: 262144,
            maxOutputTokens: 4096,
            supportsImages: true,
            supportsAudio: true,
            supportsVideo: true,
          },
        ],
        supportsImages: true,
        isDefault: true,
      }),
    });
    assert.equal(provider.status, 201);
    const appearance = await fetch(api.url + '/settings/appearance', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'system', theme: 'mukai' }),
    });
    assert(appearance.ok, await appearance.clone().text());
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // tsx preserves function names with this helper inside serialized evaluations.
    await page.addInitScript('globalThis.__name = (value) => value;');
    await page.addInitScript(
      ({ id }) => {
        localStorage.setItem('mukai.active-conversation.scout', id);
      },
      { id: conversation.id },
    );
    await page.goto(vite.resolvedUrls!.local[0]);
    mkdirSync(resolve('artifacts'), { recursive: true });
    async function checkAttachmentPreviews(scope: Locator, names: string[]) {
      for (const name of names) {
        const opener = scope.getByRole('button', { name: `Preview ${name}`, exact: true });
        if (name.endsWith('.txt')) {
          await opener.focus();
          await opener.press('Enter');
        } else await opener.click();
        const dialog = page.getByRole('dialog', { name, exact: true });
        try {
          await dialog.getByRole('link', { name: 'Download', exact: true }).waitFor();
        } catch (error) {
          console.error(
            'Attachment preview failed:',
            name,
            await page.getByRole('dialog').allTextContents(),
          );
          await page.screenshot({ path: resolve('artifacts/attachment-preview-failed.png') });
          throw error;
        }
        if (name.endsWith('.png')) {
          await dialog.locator('img').waitFor();
          await page.waitForFunction(
            () => (document.querySelector<HTMLImageElement>('dialog img')?.naturalWidth || 0) > 0,
          );
          await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
          assert.equal(
            await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).innerText(),
            '125%',
          );
          await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).click();
          await page.screenshot({ path: resolve('artifacts/attachment-preview.png') });
        } else if (name.endsWith('.wav') || name.endsWith('.mp4')) {
          const player = dialog.locator(name.endsWith('.wav') ? 'audio' : 'video');
          await player.waitFor();
          assert(
            await player.evaluate(
              (element: HTMLMediaElement) => element.controls && !element.autoplay,
            ),
          );
        } else {
          await dialog.locator('pre').waitFor();
          assert((await dialog.locator('pre').innerText()).includes('reference document'));
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert(await opener.evaluate((element) => document.activeElement === element));
      }
    }
    const composer = page.locator('.ai-composer-area .composer > textarea');
    await composer.waitFor({ timeout: 15000 });
    const png = await sharp({
      create: { width: 24, height: 16, channels: 3, background: '#0088cc' },
    })
      .png()
      .toBuffer();
    await page.getByLabel('Upload chat attachments').setInputFiles([
      {
        name: 'original.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Initial reference document'),
      },
      { name: 'original.png', mimeType: 'image/png', buffer: png },
      { name: 'original.wav', mimeType: 'audio/wav', buffer: wavFixture() },
      { name: 'original.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() },
    ]);
    await page.waitForFunction(
      () => document.querySelectorAll('.ai-pending-attachments .ai-attachment').length === 4,
    );
    await composer.fill('Review the layout and explain your approach.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Stop generation', exact: true }).waitFor();
    await checkAttachmentPreviews(page.locator('.ai-message--user').first(), [
      'original.txt',
      'original.png',
      'original.wav',
      'original.mp4',
    ]);
    const liveWork = page.locator('.response-work > summary');
    await liveWork.filter({ hasText: /(?:Thinking|Responding) for/ }).waitFor();
    const initialDuration = await liveWork.innerText();
    await page.waitForFunction(
      (initial) => document.querySelector('.response-work > summary')?.textContent !== initial,
      initialDuration.trim(),
    );
    await page.locator('.response-reasoning').waitFor();
    assert.equal(await page.locator('.response-work').getAttribute('open'), '');
    await liveWork.click();
    await page.waitForFunction(
      () => !document.querySelector('.response-work')?.hasAttribute('open'),
    );
    assert.equal(await composer.isEnabled(), true);
    assert.equal(
      await page.getByRole('button', { name: 'Attach images or files', exact: true }).isEnabled(),
      true,
    );
    await page.getByLabel('Upload chat attachments').setInputFiles([
      {
        name: 'guidance.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Original reference document'),
      },
      { name: 'layout.png', mimeType: 'image/png', buffer: png },
      { name: 'recording.wav', mimeType: 'audio/wav', buffer: wavFixture() },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() },
    ]);
    await page.waitForFunction(
      () => document.querySelectorAll('.ai-pending-attachments .ai-attachment').length === 4,
    );
    const previewNames = ['guidance.txt', 'layout.png', 'recording.wav', 'clip.mp4'];
    await checkAttachmentPreviews(page.locator('.ai-pending-attachments'), previewNames);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download guidance.txt', exact: true }).click();
    assert.equal((await downloaded).suggestedFilename(), 'guidance.txt');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await composer.fill('Focus on the mobile layout.');
    await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
    await page.getByRole('button', { name: 'Steer', exact: true }).waitFor();
    assert.equal(await page.locator('.followup-row .ai-attachment').count(), 4);
    await checkAttachmentPreviews(page.locator('.followup-row').first(), previewNames);
    assert.equal(await page.locator('.ai-pending-attachments .ai-attachment').count(), 0);
    await page.getByRole('button', { name: 'Edit queued message', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Edit queued message' })
      .fill('Use the mobile layout and keep the API stable.');
    await page.getByRole('button', { name: 'Remove guidance.txt', exact: true }).click();
    await page.getByLabel('Attach files to queued message').setInputFiles({
      name: 'revised.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Revised reference document'),
    });
    await page.getByRole('button', { name: 'Download revised.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .locator('.followup-copy')
      .filter({ hasText: 'Use the mobile layout and keep the API stable.' })
      .waitFor();
    await page.getByRole('button', { name: 'Edit queued message', exact: true }).click();
    await page.getByRole('button', { name: 'Remove revised.txt', exact: true }).click();
    await page.getByLabel('Attach files to queued message').setInputFiles({
      name: 'cancelled.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Cancelled editor upload'),
    });
    await page.getByRole('button', { name: 'Download cancelled.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Download revised.txt', exact: true }).waitFor();
    await page.getByLabel('Upload chat attachments').setInputFiles({
      name: 'discard.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Then summarize the changes.'),
    });
    await page.getByRole('button', { name: 'Download discard.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.followup-row').length === 2);
    mkdirSync(resolve('artifacts'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/steering-pending.png') });
    const stopBounds = await page
      .getByRole('button', { name: 'Stop generation', exact: true })
      .boundingBox();
    const composerBounds = await page.locator('.composer').boundingBox();
    assert(
      stopBounds && composerBounds && stopBounds.x > composerBounds.x + composerBounds.width - 80,
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');
    await page.screenshot({
      path: resolve('artifacts/steering-pending-dark.png'),
      animations: 'disabled',
    });
    const contrast = await page.evaluate(() => {
      const button = document.querySelector('.followup-steer')!;
      const foreground = getComputedStyle(button);
      const background = getComputedStyle(button.closest('.followup-row')!).backgroundColor;
      const rgb = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const bg = rgb(background),
        opacity = Number(foreground.opacity);
      const text = rgb(foreground.color).map(
        (value, index) => value * opacity + bg[index] * (1 - opacity),
      );
      const luminance = (values: number[]) =>
        values
          .map((value) => {
            const component = value / 255;
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const a = luminance(text),
        b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert(contrast >= 4.5, `Steer needs readable contrast in dark mode (measured ${contrast}).`);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.followup-row').length === 2);
    await page
      .locator('.response-work > summary')
      .filter({ hasText: /(?:Thinking|Responding) for/ })
      .waitFor();
    assert.equal(await page.locator('.response-work').getAttribute('open'), '');
    await page.locator('.response-work > summary').click();
    await page.waitForFunction(
      () => !document.querySelector('.response-work')?.hasAttribute('open'),
    );
    await page.getByRole('button', { name: 'Delete queued message', exact: true }).last().click();
    await page.waitForFunction(() => document.querySelectorAll('.followup-row').length === 1);
    continueWork = true;
    await page.getByRole('button', { name: 'Steer', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.followup-queue'));
    assert(inputs.at(-1)!.includes('Use the mobile layout and keep the API stable.'));
    assert(!inputs.at(-1)!.includes('Then summarize the changes.'));
    assert(inputs.at(-1)!.includes('Revised reference document'));
    assert(inputs.at(-1)!.includes('image_url'));
    assert(inputs.at(-1)!.includes('input_audio'));
    assert(inputs.at(-1)!.includes('video_url'));
    assert(!inputs.at(-1)!.includes('Cancelled editor upload'));
    assert.equal(inputs.length, 2);
    const userSteer = page.locator('.ai-message--steering');
    await userSteer.waitFor();
    assert.equal(await userSteer.locator('.ai-attachment').count(), 4);
    await checkAttachmentPreviews(userSteer, [
      'revised.txt',
      'layout.png',
      'recording.wav',
      'clip.mp4',
    ]);
    assert.equal(await userSteer.locator('.ai-message-meta > strong').innerText(), 'You');
    const timestamp = api.store.get(
      "SELECT created_at FROM chat_followups WHERE state='applied'",
    )?.created_at;
    assert.equal(await userSteer.locator('time').getAttribute('datetime'), timestamp);
    assert.equal(
      await userSteer.locator('.steering-message-icon').getAttribute('aria-label'),
      'Steered this task',
    );
    await page.screenshot({
      path: resolve('artifacts/steering-collapsed.png'),
      animations: 'disabled',
    });
    const worked = page.locator('.response-work > summary');
    assert.match(await worked.innerText(), /^Worked for /);
    await worked.click();
    await page.locator('.response-steering').waitFor();
    assert.equal(await page.locator('.response-steering .ai-attachment').count(), 4);
    await checkAttachmentPreviews(page.locator('.response-steering'), [
      'revised.txt',
      'layout.png',
      'recording.wav',
      'clip.mp4',
    ]);
    await page.waitForFunction(() => !document.querySelector('.ai-message--steering'));
    await page.screenshot({ path: resolve('artifacts/steering-applied.png') });
    await worked.click();
    await userSteer.waitFor();
    assert.equal(await page.locator('.response-steering').isVisible(), false);
    await page.reload();
    await userSteer.waitFor();
    assert.equal(await userSteer.locator('time').getAttribute('datetime'), timestamp);
    assert.deepEqual(errors, []);
    console.log(
      'Steering UI smoke passed: attachment modals in regular, draft, queued, collapsed and expanded steering; image zoom, media controls, text preview, independent downloads, keyboard access, editing/cancellation, refresh and delivery.',
    );
  } finally {
    await browser.close();
    await vite.close();
    await api.shutdown();
    await close(api.server);
    api.dispose();
    await close(fixture);
    assert(resolve(dir).startsWith(resolve(tmpdir(), 'mukai-steering-ui-')));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
