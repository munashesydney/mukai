import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import { activeInstallation, runtimeExecutable } from '../../src/cli/installation';
import type { ServerState } from '../../src/cli/serverState';

const run = promisify(execFile);
const oldVersion = '0.1.0-build.9.1',
  newVersion = '0.1.0-build.10.1';
const releases = 'https://github.com/munashesydney/mukai/releases';

async function main() {
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/cli-updates-'));
  const oldRoot = join(directory, 'versions/old/mukai');
  const newRoot = join(directory, 'payload/mukai');
  const dataDir = join(directory, 'user data');
  const manifestFile = join(directory, 'cli-manifest.json');
  const archiveFile = join(directory, 'fixture.tar');
  // Only these disposable fixture bundles redirect release downloads. Production
  // always uses the fixed GitHub release origin and contains no test override.
  const banner = `const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === ${JSON.stringify(releases + '/latest/download/cli-manifest.json')})
    return Response.json(JSON.parse(require('node:fs').readFileSync(process.env.MUKAI_FIXTURE_MANIFEST, 'utf8')));
  if (url.startsWith(${JSON.stringify(releases + '/download/')}))
    return new Response(require('node:fs').readFileSync(process.env.MUKAI_FIXTURE_ARCHIVE));
  return fixtureFetch(input, init);
};`;
  try {
    for (const [root, version] of [
      [oldRoot, oldVersion],
      [newRoot, newVersion],
    ]) {
      await mkdir(join(root, 'app'), { recursive: true });
      await mkdir(join(root, 'runtime'));
      await link(process.execPath, runtimeExecutable(root)).catch(() =>
        copyFile(process.execPath, runtimeExecutable(root)),
      );
      await cp('dist/web', join(root, 'web'), { recursive: true });
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          product: 'mukai-cli',
          version,
          platform: process.platform,
          arch: process.arch,
        }),
      );
      await build({
        entryPoints: ['src/cli/index.ts'],
        outfile: join(root, 'app/cli.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        packages: 'external',
        define: { __MUKAI_VERSION__: JSON.stringify(version) },
        banner: { js: banner },
      });
    }
    if (process.platform === 'win32') {
      await mkdir(join(directory, 'bin'));
      await writeFile(
        join(directory, 'bin/mukai.cmd'),
        '@echo off\r\nrem Mukai CLI launcher\r\n"%~dp0..\\versions\\old\\mukai\\runtime\\node.exe" "%~dp0..\\versions\\old\\mukai\\app\\cli.cjs" %*\r\n',
      );
    } else await writeFile(join(directory, 'active-version'), 'old\n');
    await run('tar', ['-cf', archiveFile, '-C', join(directory, 'payload'), 'mukai']);
    const archive = await readFile(archiveFile);
    await writeFile(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        version: newVersion,
        artifacts: [
          {
            platform: process.platform,
            arch: process.arch,
            file: `mukai-cli-${newVersion}-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
            sha256: createHash('sha256').update(archive).digest('hex'),
          },
        ],
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_PATH: resolve('node_modules'),
      MUKAI_FIXTURE_MANIFEST: manifestFile,
      MUKAI_FIXTURE_ARCHIVE: archiveFile,
    };
    delete env.NODE_OPTIONS;
    const child = spawn(
      runtimeExecutable(oldRoot),
      [join(oldRoot, 'app/cli.cjs'), 'serve', '--port', '0', '--data-dir', dataDir],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    let browser: Browser | undefined;
    try {
      let state: ServerState | undefined;
      for (let i = 0; i < 200; i++) {
        try {
          state = JSON.parse(await readFile(join(dataDir, 'cli-server.json'), 'utf8'));
          break;
        } catch {
          /* Wait for startup. */
        }
        if (child.exitCode !== null) throw new Error(output);
        await setTimeout(100);
      }
      assert.ok(state, output);
      const code = new URLSearchParams(new URL(state.connectionUrl).hash.slice(1)).get(
        'mukai-setup',
      );
      const post = (path: string, value: unknown, cookie?: string) =>
        fetch(state!.url + '/api' + path, {
          method: 'POST',
          headers: {
            Origin: state!.url,
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(value),
        });
      const proof = await post('/auth/verify', { code });
      assert.equal(proof.status, 200);
      const login = await post(
        '/auth/setup',
        { username: 'update-owner', password: 'disposable update smoke password' },
        proof.headers.get('set-cookie')!.split(';')[0],
      );
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const workspace = join(directory, 'workspace');
      await mkdir(workspace);
      assert.equal(
        (await post('/workspaces', { name: 'Saved before update', folder: workspace }, cookie))
          .status,
        201,
      );
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext({ viewport: { width: 1480, height: 940 } });
      const split = cookie.indexOf('=');
      await context.addCookies([
        { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: state.url },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(state.url);
      await page.getByRole('button', { name: 'Open settings' }).click();
      await page.getByRole('tab', { name: 'Updates', exact: true }).click();
      const automatic = page.getByRole('switch', { name: 'Automatic updates' });
      await automatic.waitFor();
      await automatic.click();
      await page
        .getByText('Off for this installation. You can still check for updates above.')
        .waitFor();
      await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
      const restart = page.getByRole('button', { name: 'Restart to update', exact: true }).last();
      await restart.waitFor({ timeout: 30000 });
      page.once('dialog', (dialog) => void dialog.dismiss());
      await restart.click();
      assert.equal(
        ((await (await fetch(state.url + '/health')).json()) as { version: string }).version,
        oldVersion,
      );
      // A terminal update activates a fresh version without interrupting the old
      // server. The browser restart must handle that concurrent activation.
      const terminal = await run(
        runtimeExecutable(oldRoot),
        [join(oldRoot, 'app/cli.cjs'), 'update'],
        { env, timeout: 30000, windowsHide: true },
      );
      assert.match(terminal.stdout, /is installed/);
      assert.equal(
        ((await (await fetch(state.url + '/health')).json()) as { version: string }).version,
        oldVersion,
      );
      const active = await activeInstallation({
        directory,
        platform: process.platform,
        arch: process.arch,
      });
      assert.notEqual(active, oldRoot);
      page.once('dialog', (dialog) => void dialog.accept());
      await Promise.all([page.waitForEvent('load', { timeout: 30000 }), restart.click()]);
      const replacement = JSON.parse(
        await readFile(join(dataDir, 'cli-server.json'), 'utf8'),
      ) as ServerState;
      assert.equal(replacement.url, state.url);
      assert.equal(replacement.version, newVersion);
      assert.notEqual(replacement.pid, state.pid);
      const headers = { Cookie: cookie, Origin: state.url };
      const workspaces = (await (
        await fetch(state.url + '/api/workspaces', { headers })
      ).json()) as { name: string }[];
      assert.ok(workspaces.some((workspace) => workspace.name === 'Saved before update'));
      const updateState = (await (
        await fetch(state.url + '/api/settings/updates', { headers })
      ).json()) as { automaticUpdates: boolean; currentVersion: string };
      assert.equal(updateState.automaticUpdates, false);
      assert.equal(updateState.currentVersion, newVersion);
      await page.getByRole('button', { name: 'Open settings' }).click();
      await page.getByRole('tab', { name: 'Updates', exact: true }).click();
      await page.getByText(newVersion, { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('switch', { name: 'Automatic updates' }).isChecked(),
        false,
      );
      await page.screenshot({
        path: resolve('artifacts/cli-updates-browser.png'),
        animations: 'disabled',
      });
      assert.deepEqual(errors, []);
      child.send({ type: 'mukai:shutdown' });
      assert.equal(
        await Promise.race([exited, setTimeout(15000).then(() => 'timeout')]),
        0,
        output,
      );
      await assert.rejects(readFile(join(dataDir, 'server.lock')), { code: 'ENOENT' });
      console.log(
        'CLI update smoke passed: terminal upgrade, authenticated browser checks/download, restart cancellation, replacement Node runtime, same ephemeral port, persisted workspace/login/preference, UI reconnect, and foreground shutdown.',
      );
    } finally {
      await browser?.close();
      if (child.exitCode === null) {
        if (child.connected) child.send({ type: 'mukai:shutdown' });
        await Promise.race([exited, setTimeout(10000)]);
        if (child.exitCode === null) {
          child.kill();
          await exited;
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
