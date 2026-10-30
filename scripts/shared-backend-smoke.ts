import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  _electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from 'playwright-core';
import { runningServer, type ServerState } from '../src/server/backendState';
import type { DesktopBridge } from '../src/shared/contracts';

const require = createRequire(join(process.cwd(), 'package.json'));

async function main() {
  await mkdir('artifacts', { recursive: true });
  const root = await mkdtemp(resolve('artifacts/shared-backend-'));
  const children = new Set<ChildProcess>();
  let desktop: ElectronApplication | undefined;
  let browser: Browser | undefined;
  const blocker = createServer((_request, response) => response.end('Unrelated backend'));
  let blockingDefault = false;
  const rendererErrors: string[] = [];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  async function waitForState(dataDir: string, child?: ChildProcess): Promise<ServerState> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const state = await runningServer(dataDir);
      if (state) return state;
      if (child && child.exitCode !== null) throw new Error('CLI exited before becoming ready.');
      await setTimeout(100);
    }
    throw new Error(`Backend did not become ready for ${dataDir}`);
  }
  function cli(dataDir: string, port: number) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('src/cli/index.ts'),
        'serve',
        '--data-dir',
        dataDir,
        '--port',
        String(port),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    children.add(child);
    let output = '';
    child.stdout!.on('data', (bytes) => {
      output += String(bytes);
    });
    child.stderr!.on('data', (bytes) => {
      output += String(bytes);
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        children.delete(child);
        done(code);
      });
    });
    return { child, exited, output: () => output };
  }
  async function launchDesktop(dataDir: string, name: string) {
    desktop = await _electron.launch({
      executablePath: require('electron') as string,
      args: [resolve('.'), `--user-data-dir=${join(root, name)}`],
      env: Object.fromEntries(
        Object.entries({ ...env, MUKAI_DATA_DIR: dataDir }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    await page
      .getByRole('heading', { name: 'Create your first workspace.', exact: true })
      .waitFor();
    return page;
  }
  async function nativeWorkspaces(page: Page, name?: string) {
    const folder = name ? join(root, 'workspaces', name) : undefined;
    if (folder) await mkdir(folder, { recursive: true });
    return page.evaluate(
      async ({ workspaceName, folder }) => {
        const bridge = (window as unknown as { mukai: DesktopBridge }).mukai;
        const { url, token } = await bridge.getApiConnection();
        const response = await fetch(`${url}/workspaces`, {
          method: workspaceName ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(workspaceName ? { body: JSON.stringify({ name: workspaceName, folder }) } : {}),
        });
        if (!response.ok) throw new Error(`Native API failed (${response.status})`);
        return response.json() as Promise<
          { id: string; name: string }[] | { id: string; name: string }
        >;
      },
      { workspaceName: name, folder },
    );
  }

  try {
    blockingDefault = await new Promise<boolean>((done, reject) => {
      blocker.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') done(false);
        else reject(error);
      });
      blocker.listen(47831, '127.0.0.1', () => done(true));
    });
    const desktopData = join(root, 'desktop-owned');
    const page = await launchDesktop(desktopData, 'desktop-profile');
    const state = await waitForState(desktopData);
    assert.notEqual(
      new URL(state.url).port,
      '47831',
      'Desktop must avoid a port owned by another directory.',
    );
    const reused = cli(desktopData, 0);
    assert.equal(await reused.exited, 0, reused.output());
    assert.match(reused.output(), /Reusing the existing backend/);
    assert.equal((await waitForState(desktopData)).instanceId, state.instanceId);
    await nativeWorkspaces(page, 'Shared from desktop');

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const web = await browser.newPage();
    web.on('pageerror', (error) => rendererErrors.push(error.message));
    await web.goto(state.connectionUrl);
    await web.getByRole('heading', { name: 'Connect your Mukai.' }).waitFor();
    await web
      .getByLabel('Setup code')
      .fill(new URLSearchParams(new URL(state.connectionUrl).hash.slice(1)).get('mukai-setup')!);
    await web.getByRole('button', { name: 'Continue', exact: true }).click();
    await web.getByLabel('Username', { exact: true }).fill('shared-smoke@example.com');
    await web.getByLabel('Password', { exact: true }).fill('disposable shared smoke password');
    await web
      .getByLabel('Confirm password', { exact: true })
      .fill('disposable shared smoke password');
    await web.getByRole('button', { name: 'Create login & open Mukai' }).click();
    await web.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const webWorkspaces = (await web.evaluate(async () =>
      (await fetch('/api/workspaces')).json(),
    )) as { name: string }[];
    assert(webWorkspaces.some((workspace) => workspace.name === 'Shared from desktop'));
    assert(
      ((await nativeWorkspaces(page)) as { name: string }[]).some(
        (workspace) => workspace.name === 'Shared from desktop',
      ),
    );

    await page.evaluate(() => (window as unknown as { mukai: DesktopBridge }).mukai.close());
    assert.equal(
      await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    assert.equal(await web.evaluate(async () => (await fetch('/api/workspaces')).status), 200);
    await desktop!.evaluate(({ app }) => app.emit('activate'));
    assert.equal(
      await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    );
    await page.screenshot({ path: join(root, 'desktop-shared.png') });
    await web.screenshot({ path: join(root, 'browser-shared.png') });
    await desktop!.close();
    desktop = undefined;
    assert.equal(await runningServer(desktopData), null);
    await browser.close();
    browser = undefined;
    console.log(
      'PASS desktop first: default-port conflict, CLI reuse, browser login, shared data, close/reopen.',
    );

    const primaryData = join(root, 'cli-primary');
    const secondaryData = join(root, 'cli-secondary');
    const primary = cli(primaryData, 0);
    const secondary = cli(secondaryData, 0);
    const [primaryState, secondaryState] = await Promise.all([
      waitForState(primaryData, primary.child),
      waitForState(secondaryData, secondary.child),
    ]);
    assert.notEqual(primaryState.url, secondaryState.url);
    const attached = await launchDesktop(primaryData, 'attached-profile');
    const connection = await attached.evaluate(() =>
      (window as unknown as { mukai: DesktopBridge }).mukai.getApiConnection(),
    );
    assert.equal(connection.url, primaryState.url + '/api');
    const preference = await attached.evaluate(() =>
      (window as unknown as { mukai: DesktopBridge }).mukai.setAutomaticUpdates(false),
    );
    assert.equal(preference.automaticUpdates, false);
    const savedPreference = await fetch(primaryState.url + '/api/settings/updates', {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.equal(
      ((await savedPreference.json()) as { automaticUpdates: boolean }).automaticUpdates,
      false,
    );
    await nativeWorkspaces(attached, 'Shared from attached desktop');
    assert.equal((await waitForState(primaryData)).pid, primary.child.pid);
    await desktop!.close();
    desktop = undefined;
    assert.equal(
      (await fetch(primaryState.url + '/health')).status,
      200,
      'Quitting an attached desktop must leave the CLI backend running.',
    );
    assert.equal((await fetch(secondaryState.url + '/health')).status, 200);
    primary.child.send({ type: 'mukai:shutdown' });
    secondary.child.send({ type: 'mukai:shutdown' });
    assert.equal(await primary.exited, 0, primary.output());
    assert.equal(await secondary.exited, 0, secondary.output());
    assert.deepEqual(rendererErrors, []);
    console.log(
      'PASS CLI first: separate ephemeral backends, directory selection, native API, shutdown ownership.',
    );
    console.log(`Screenshots: ${root}`);
  } finally {
    await desktop?.close();
    await browser?.close();
    for (const child of children) child.kill();
    if (blockingDefault) await new Promise<void>((done) => blocker.close(() => done()));
    // Retain screenshots; the temporary profiles and credentials are disposable.
    for (const name of [
      'desktop-owned',
      'desktop-profile',
      'cli-primary',
      'cli-secondary',
      'attached-profile',
      'workspaces',
    ])
      await rm(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
