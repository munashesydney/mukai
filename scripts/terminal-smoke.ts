import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright-core';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';
import type { ChatActivity } from '../src/shared/ai';
import { terminalSnapshotSchema } from '../src/shared/terminal';

async function main() {
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/terminal-smoke-'));
  const api = await startApiServer(0, {
    dataDir: join(directory, 'data'),
    webDir: resolve('dist/web'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  let browser: Browser | undefined;
  try {
    seedTestBot(api.store);
    api.store.run(
      "UPDATE workspaces SET name='Terminal preview',folder=? WHERE id='default'",
      directory,
    );
    const conversation = new ConversationRepository(api.store).createPrivate('default', 'scout');
    const post = (path: string, value: unknown, cookie?: string) =>
      fetch(api.url + '/api' + path, {
        method: 'POST',
        headers: {
          Origin: api.url,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(value),
      });
    const proof = await post('/auth/verify', { code: api.ownerAuth!.setupCode });
    const login = await post(
      '/auth/setup',
      { username: 'terminal-owner', password: 'disposable smoke password' },
      proof.headers.get('set-cookie')!.split(';')[0],
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      viewport: { width: 1480, height: 940 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const split = cookie.indexOf('=');
    await context.addCookies([
      { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: api.url },
    ]);
    const secret = 'smoke-terminal-secret-123456';
    api.capabilities.environment.save('default', [{ name: 'REPORT_API_KEY', value: secret }]);
    const file = join(directory, 'report.cjs');
    await writeFile(
      file,
      `const fs=require('node:fs');
console.log('Preparing report for October');
console.log('Selected account: demo-workspace');
console.log('API key: '+process.env.REPORT_API_KEY);
console.log('Column preview: '+Array.from({length:30},(_,i)=>'column_'+i).join(' | '));
let n=0; const timer=setInterval(()=>{console.log('Processed batch '+(++n));if(fs.existsSync('finish-report')){clearInterval(timer);console.log('Report saved.');}},500);`,
    );
    const command =
      process.platform === 'win32'
        ? `& '${process.execPath.replaceAll("'", "''")}' '${file.replaceAll("'", "''")}'; exit $LASTEXITCODE`
        : `'${process.execPath}' '${file}'`;
    const owner = { workspaceId: 'default', botId: 'scout', conversationId: conversation.id };
    const session = await api.processes.run(
      owner,
      directory,
      { command, background: true, envFromSettings: ['REPORT_API_KEY'] },
      new AbortController().signal,
    );
    const snapshot = terminalSnapshotSchema.parse(session);
    const activity: ChatActivity[] = [
      {
        id: 'report-run',
        tool: 'terminal',
        action: 'run',
        path: command,
        status: 'complete',
        summary: '',
        processSessionId: session.id,
        terminal: snapshot,
      },
      {
        id: 'report-poll',
        tool: 'terminal',
        action: 'poll',
        path: session.id,
        status: 'complete',
        summary: '',
        processSessionId: session.id,
        terminal: snapshot,
      },
      {
        id: 'failed-run',
        tool: 'terminal',
        action: 'run',
        path: 'python missing-report.py',
        status: 'complete',
        summary: '',
        terminal: {
          id: randomUUID(),
          command: 'python missing-report.py',
          cwd: directory,
          shell: snapshot.shell,
          output: "python: can't open file 'missing-report.py': No such file or directory\n",
          status: 'exited',
          exitCode: 2,
          createdAt: new Date().toISOString(),
        },
      },
    ];
    api.store.run(
      "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id,activity_json,parts_json) VALUES(?,'scout',?,'assistant','The report is running in the background.','complete',?,?,?,?)",
      randomUUID(),
      randomUUID(),
      new Date().toISOString(),
      conversation.id,
      JSON.stringify(activity),
      JSON.stringify([
        ...activity.map((item) => ({ id: item.id, type: 'tool', activityId: item.id })),
        {
          id: 'answer',
          type: 'text',
          text: 'The report is running in the background.',
          final: true,
        },
      ]),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(api.url);
    await page.getByText('The report is running in the background.', { exact: true }).waitFor();
    await page.locator('.response-work > summary').click();
    await page
      .locator('.terminal-transcript')
      .filter({ hasText: 'Preparing report for October' })
      .waitFor();
    assert.equal(
      await page.locator('.terminal-card').count(),
      2,
      'Process polling must reuse the original terminal card.',
    );
    assert(
      await page
        .locator('.terminal-state')
        .filter({ hasText: /^Running$/ })
        .isVisible(),
    );
    assert(await page.getByText('Failed · exit 2', { exact: true }).isVisible());
    assert(!(await page.locator('.terminal-transcript').first().innerText()).includes(secret));
    assert((await page.locator('.terminal-transcript').first().innerText()).includes('[redacted]'));
    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'dark';
    });
    await page.screenshot({
      path: resolve('artifacts/terminal-card-dark.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'light';
    });
    await page.screenshot({
      path: resolve('artifacts/terminal-card-light.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve('artifacts/terminal-card-mobile.png'),
      animations: 'disabled',
    });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Terminal cards must not create page overflow.',
    );
    await page.setViewportSize({ width: 1480, height: 940 });
    const report = page.locator('.terminal-card').first();
    await report.getByRole('button', { name: 'Copy command', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
    await writeFile(join(directory, 'finish-report'), 'done');
    await api.processes.wait(owner, session.id, 20000, new AbortController().signal);
    await page.waitForFunction(
      () =>
        document.querySelector('.terminal-card .terminal-toggle')?.getAttribute('aria-expanded') ===
        'false',
      undefined,
      { timeout: 20000 },
    );
    await report.locator('.terminal-toggle').click();
    await report.getByText('Success', { exact: true }).waitFor();
    assert((await report.locator('.terminal-transcript').innerText()).includes('Report saved.'));
    await report.getByRole('button', { name: 'Copy terminal output' }).click();
    assert(!(await page.evaluate(() => navigator.clipboard.readText())).includes(secret));
    const retained = String(
      api.store.get('SELECT activity_json FROM messages WHERE conversation_id=?', conversation.id)
        ?.activity_json,
    );
    assert(retained.includes('Report saved.'));
    assert(!retained.includes(secret));
    assert.deepEqual(errors, []);
    assert.equal((await readFile(file, 'utf8')).includes(secret), false);
    console.log(
      'Terminal UI smoke passed: live output, per-process status, grouped polls, secret redaction, copying, retained output, dark/light themes, and mobile layout.',
    );
  } finally {
    await browser?.close();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
