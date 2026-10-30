import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { parseDotEnv } from '../src/shared/dotEnv';
import type { CapabilityRegistration } from '../src/shared/customCapabilities';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-jobs-ui-'));
  const folder = join(root, 'workspace');
  await mkdir(folder);
  const api = await startApiServer(0, { dataDir: join(root, 'data'), webDir: resolve('dist/web') });
  let browser: Browser | undefined;
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    seedTestBot(api.store);
    api.workspaces.update('default', { name: 'Jobs QA', folder });
    const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
    api.store.run(
      "INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('job-qa-message','scout',?,'job-qa-request','assistant','Review this request.','complete',?)",
      conversation.id,
      new Date().toISOString(),
    );
    await writeFile(
      join(folder, 'once.ts'),
      `import {join} from 'node:path';import {writeFileSync} from 'node:fs';export default {name:'daily_check',description:'A disposable one-shot job',triggers:[{type:'once',runAt:'2099-01-01T00:00:00Z'}],run(event,context){writeFileSync(join(context.workspacePath,'path-proof.txt'),'written');return {trigger:event.trigger,workspace:context.workspaceId};}}`,
    );
    const registered = (await api.capabilities.manage('default', 'scout', 'job', {
      operation: 'register',
      modulePath: 'once.ts',
    })) as CapabilityRegistration;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 700 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Custom jobs', exact: true }).click();
    await page.getByRole('heading', { name: 'Custom jobs.', exact: true }).waitFor();
    await page.getByRole('button', { name: /daily_check/ }).click();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await page.getByRole('button', { name: 'Run now', exact: true }).last().click();
    await page.getByLabel('Test result').filter({ hasText: 'manual' }).waitFor();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page
      .getByRole('listitem')
      .filter({ hasText: /complete ·/ })
      .waitFor();
    await mkdir('artifacts/custom-jobs', { recursive: true });
    await page.screenshot({ path: 'artifacts/custom-jobs/job-history.png' });
    assert.equal(await readFile(join(folder, 'path-proof.txt'), 'utf8'), 'written');
    await writeFile(
      join(folder, 'once.ts'),
      `export default {name:'daily_check',description:'A disposable one-shot job',triggers:[{type:'once',runAt:'2099-01-01T00:00:00Z'}],run(){throw new Error('UI health probe failed');}}`,
    );
    await api.capabilities.manage('default', 'scout', 'job', {
      operation: 'update',
      id: registered.id,
    });
    for (let attempt = 0; attempt < 2; attempt++)
      await api.capabilities
        .manage('default', 'scout', 'job', { operation: 'run_now', id: registered.id })
        .catch(() => {});
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByText('2 consecutive failures', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'All tools', exact: true }).click();
    await page.getByRole('button', { name: 'Custom jobs', exact: true }).click();
    await page.getByText('2 consecutive failures', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/custom-jobs/job-failure-health.png' });
    await page.getByRole('button', { name: /daily_check/ }).click();
    await page.getByText('2 consecutive failures', { exact: true }).waitFor();
    await page.locator('.job-health-error').filter({ hasText: 'UI health probe failed' }).waitFor();
    const exportValues = [
      { name: 'UI_EXPORT_TOKEN', value: 'dummy-ui-only "quotes" \\n and\nnew line' },
      { name: 'UI_EMPTY', value: '' },
    ];
    api.capabilities.environment.save('default', exportValues);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('tab', { name: 'E Variables', exact: true }).click();
    await page.getByText('UI_EXPORT_TOKEN', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Export .env', exact: true }).isVisible(),
      false,
    );
    await page.getByText('Developer view', { exact: true }).click();
    assert(!(await page.locator('body').innerText()).includes('dummy-ui-only'));
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export .env', exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'mukai-environment.env');
    const downloadPath = await download.path();
    assert(downloadPath);
    assert.deepEqual(
      parseDotEnv(await readFile(downloadPath, 'utf8')),
      [...exportValues].sort((a, b) => a.name.localeCompare(b.name)),
    );
    assert(!(await page.locator('body').innerText()).includes('dummy-ui-only'));
    await page.screenshot({ path: 'artifacts/custom-jobs/environment-developer-export.png' });
    pending = api.approvals
      .ask(
        {
          botId: 'scout',
          botName: 'Scout',
          conversationId: conversation.id,
          messageId: 'job-qa-message',
          toolCallId: 'job-qa-ask',
          toolName: 'communicate',
          input: {},
          batchId: 'job-qa-batch',
        },
        {
          action: 'approval',
          question: (
            'Review this long approval request and its full details.\n' +
            'This is disposable preview text with no external action.\n'
          ).repeat(15),
        },
        controller.signal,
        () => {},
        () => {},
      )
      .catch(() => {});
    await page.getByRole('button', { name: 'Bots', exact: true }).click();
    // Open the conversation from the existing bot's sidebar entry.
    const parent = page.locator('.bot-conversation-parent').filter({ hasText: 'Scout' });
    if ((await parent.getAttribute('aria-expanded')) !== 'true') await parent.click();
    await page.locator('.bot-conversation-row').first().click();
    await page.getByRole('region', { name: 'Request details', exact: true }).waitFor();
    for (const viewport of [
      { width: 1360, height: 700 },
      { width: 900, height: 560 },
      { width: 640, height: 560 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const footer = page.locator('.ask-composer .ask-request-footer');
      const scroll = page.getByRole('region', { name: 'Request details' });
      const bounds = await footer.boundingBox();
      assert(bounds);
      assert(
        bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
        'Approval buttons must stay within the window',
      );
      assert.equal(await footer.evaluate((e) => getComputedStyle(e).position), 'sticky');
      assert(
        await scroll.evaluate((e) => e.scrollHeight > e.clientHeight),
        'Long approval details should scroll',
      );
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      const after = await footer.boundingBox();
      assert(after);
      assert(
        Math.abs(after.y - bounds.y) < 1,
        'Scrolling request text must not move approval actions',
      );
      await page.screenshot({
        path: `artifacts/custom-jobs/approval-${viewport.width}x${viewport.height}.png`,
      });
    }
    await page.getByRole('button', { name: 'Deny with reason', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Reason for denying' })
      .fill('This is only a disposable UI check.');
    await page.getByRole('button', { name: 'Deny with reason', exact: true }).click();
    await pending;
    assert.equal(api.approvals.state('default').pending.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      'Custom jobs workspace paths, failure health, developer environment export, and sticky approvals passed.',
    );
  } finally {
    controller.abort();
    await pending;
    await browser?.close();
    await api.shutdown();
    await new Promise<void>((done) => api.server.close(() => done()));
    api.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
