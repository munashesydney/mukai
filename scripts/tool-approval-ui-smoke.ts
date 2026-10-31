import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';
import type { CustomToolPresentation } from '../src/shared/customCapabilities';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-tool-approval-ui-'));
  const api = await startApiServer(0, { dataDir: root, webDir: resolve('dist/web') });
  let browser: Browser | undefined;
  let pending: Promise<unknown> | undefined;
  const controller = new AbortController();
  try {
    seedTestBot(api.store);
    const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
    api.store.run(
      "INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('approval-ui','scout',?,'approval-ui','assistant','Please review.','complete',?)",
      conversation.id,
      new Date().toISOString(),
    );
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 700 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${api.url}/#mukai-connect=${api.browserSession!.connectToken}`);
    await page.getByRole('button', { name: 'Bots', exact: true }).click();
    const parent = page.locator('.bot-conversation-parent').filter({ hasText: 'Scout' });
    if ((await parent.getAttribute('aria-expanded')) !== 'true') await parent.click();
    await page.locator('.bot-conversation-row').first().click();
    await mkdir('artifacts/tool-approvals', { recursive: true });
    for (const configured of [false, true]) {
      const presentation: CustomToolPresentation | undefined = configured
        ? {
            title: 'Send this **email**?',
            fields: [
              { parameter: 'to', label: 'Recipient' },
              { parameter: 'body', label: 'Message', presentation: 'long_text' },
              { parameter: 'privateValue', label: 'Private value', presentation: 'secret' },
            ],
          }
        : undefined;
      pending = api.approvals
        .request(
          {
            botId: 'scout',
            botName: 'Scout',
            conversationId: conversation.id,
            messageId: 'approval-ui',
            toolCallId: 'approval-ui-' + configured,
            toolName: 'send_email',
            batchId: 'approval-ui-' + configured,
            input: {
              to: 'jane@example.com',
              body:
                '# Your invoice\n\n**Total:** $250\n\n[Invoice](https://example.com/invoice)\n\n' +
                '- Review this invoice line.\n'.repeat(50) +
                '\n```text\nInvoice #1042\n```',
              privateValue: 'private-value',
              apiKey: 'never-show-this',
              options: { sendNow: true, recipients: ['Jane', 'Sam'] },
            },
            presentation,
          },
          controller.signal,
          () => {},
          true,
        )
        .catch(() => {});
      const scroll = page.getByRole('region', { name: 'Tool approval details', exact: true });
      await scroll.waitFor();
      await scroll.getByRole('heading', { name: 'Your invoice', exact: true }).waitFor();
      assert.equal(
        await scroll.getByRole('link', { name: 'Invoice', exact: true }).getAttribute('href'),
        'https://example.com/invoice',
      );
      assert(!(await scroll.innerText()).includes('never-show-this'));
      assert(!(await scroll.innerText()).includes('"to":'));
      if (configured) {
        assert(!(await scroll.innerText()).includes('private-value'));
        assert((await scroll.innerText()).includes('Recipient:'));
        assert(!(await scroll.innerText()).includes('Options:'));
      } else {
        assert((await scroll.innerText()).includes('Options:'));
        assert((await scroll.innerText()).includes('Send Now:'));
      }
      for (const viewport of [
        { width: 1360, height: 700 },
        { width: 900, height: 560 },
        { width: 640, height: 560 },
      ]) {
        await page.setViewportSize(viewport);
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const footer = page.locator('.tool-approval-footer');
        const before = await footer.boundingBox();
        assert(
          before && before.y >= 0 && before.y + before.height <= viewport.height,
          'Approval buttons must stay in view',
        );
        assert.equal(await footer.evaluate((e) => getComputedStyle(e).position), 'sticky');
        assert(
          await scroll.evaluate((e) => e.scrollHeight > e.clientHeight),
          'Long details must scroll',
        );
        if (viewport.width === 1360) {
          await scroll.evaluate((e) => {
            e.scrollTop = 0;
          });
          await page.screenshot({
            path: `artifacts/tool-approvals/${configured ? 'configured' : 'default'}-top.png`,
          });
        }
        await scroll.evaluate((e) => {
          e.scrollTop = e.scrollHeight;
        });
        const after = await footer.boundingBox();
        assert(
          after && Math.abs(after.y - before.y) < 1,
          'Scrolling details must not move actions',
        );
        await page.screenshot({
          path: `artifacts/tool-approvals/${configured ? 'configured' : 'default'}-${viewport.width}.png`,
        });
      }
      if (configured) {
        await page.getByRole('button', { name: 'Deny with reason', exact: true }).click();
        const bounds = await page.locator('.tool-approval-footer').boundingBox();
        assert(
          bounds && bounds.y >= 0 && bounds.y + bounds.height <= 560,
          'Denial actions must also stay in view',
        );
        await page
          .getByRole('textbox', { name: 'Reason for denying' })
          .fill('Disposable UI check.');
        await page.getByRole('button', { name: 'Deny with reason', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Approve tool call', exact: true }).click();
      }
      await pending;
      await page.locator('.tool-approval-card').waitFor({ state: 'detached' });
    }
    assert.deepEqual(errors, []);
    console.log(
      'Readable defaults, configured fields, Markdown, approval decisions, and sticky actions passed at three viewport sizes.',
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
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
