import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import type { DesktopBridge } from '../src/shared/contracts';

async function workspaceRequest(page: Page, folder?: string) {
  return page.evaluate(async (workspaceFolder) => {
    const bridge = (window as unknown as { mukai: DesktopBridge }).mukai;
    const { url, token } = await bridge.getApiConnection();
    const response = await fetch(`${url}/workspaces`, {
      method: workspaceFolder ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(workspaceFolder
        ? { body: JSON.stringify({ name: 'Installer smoke workspace', folder: workspaceFolder }) }
        : {}),
    });
    if (!response.ok) throw new Error(`Workspace request failed: ${response.status}`);
    return response.json() as Promise<
      { id: string; name: string }[] | { id: string; name: string }
    >;
  }, folder);
}

async function verifyUpdater(desktop: ElectronApplication, page: Page, directory: string) {
  const state = await page.evaluate(() =>
    (window as unknown as { mukai: DesktopBridge }).mukai.getUpdateState(),
  );
  if (process.platform === 'linux') {
    assert.equal(state.status, 'disabled', 'Unpacked Linux builds must not check for updates.');
    return;
  }
  assert.equal(state.status, 'idle');
  // Exercise the packaged updater and IPC without downloading or installing a
  // public release. The native installation itself needs a two-build upgrade test.
  await desktop.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule(
      'node:module',
    ) as typeof import('node:module');
    const { join } = process.getBuiltinModule('node:path') as typeof import('node:path');
    const load = createRequire(join(app.getAppPath(), 'package.json'));
    const updater = (load('electron-updater') as typeof import('electron-updater')).autoUpdater;
    updater.checkForUpdates = async () => {
      const info = {
        version: '99.0.0',
        files: [],
        path: 'unused.exe',
        sha512: 'unused',
        releaseDate: new Date().toISOString(),
      };
      updater.emit('update-available', info);
      return {
        isUpdateAvailable: true,
        updateInfo: info,
        versionInfo: info,
        downloadPromise: Promise.resolve([]),
      };
    };
  });
  await page.evaluate(() =>
    (window as unknown as { mukai: DesktopBridge }).mukai.checkForUpdates(),
  );
  await page.getByRole('button', { name: 'Downloading update… 0%' }).waitFor();
  const emit = (event: string, value: Record<string, unknown>) =>
    desktop.evaluate(
      ({ app }, data) => {
        const { createRequire } = process.getBuiltinModule(
          'node:module',
        ) as typeof import('node:module');
        const { join } = process.getBuiltinModule('node:path') as typeof import('node:path');
        const load = createRequire(join(app.getAppPath(), 'package.json'));
        const updater = (load('electron-updater') as typeof import('electron-updater')).autoUpdater;
        (updater as NodeJS.EventEmitter).emit(
          data.event,
          data.event === 'error' ? new Error('Smoke download interrupted') : data.value,
        );
      },
      { event, value },
    );
  await emit('download-progress', { percent: 42.8 });
  await page.getByRole('button', { name: 'Downloading update… 42%' }).waitFor();
  await page.screenshot({ path: join(directory, 'update-downloading.png') });
  await emit('error', {});
  await page.getByRole('button', { name: 'Update failed — Retry' }).click();
  await page.getByRole('button', { name: 'Downloading update… 0%' }).waitFor();
  await emit('update-downloaded', { version: '99.0.0' });
  await page.getByRole('button', { name: 'Restart to update' }).waitFor();
  await page.screenshot({ path: join(directory, 'update-ready.png') });
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: 'Restart to update' }).click();
  assert.equal(
    (
      await page.evaluate(() =>
        (window as unknown as { mukai: DesktopBridge }).mukai.getUpdateState(),
      )
    ).status,
    'ready',
    'Declining restart must preserve the update and the running backend.',
  );
  await emit('update-not-available', { version: state.currentVersion });
  await desktop.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule(
      'node:module',
    ) as typeof import('node:module');
    const { join } = process.getBuiltinModule('node:path') as typeof import('node:path');
    const load = createRequire(join(app.getAppPath(), 'package.json'));
    const updater = (load('electron-updater') as typeof import('electron-updater')).autoUpdater;
    updater.checkForUpdates = async () => {
      updater.emit('update-not-available', {
        version: app.getVersion(),
      } as import('electron-updater').UpdateInfo);
      return {} as import('electron-updater').UpdateCheckResult;
    };
  });
}

async function main() {
  const defaultExecutable =
    process.platform === 'win32'
      ? 'release/win-unpacked/Mukai.exe'
      : process.platform === 'darwin'
        ? `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Mukai.app/Contents/MacOS/Mukai`
        : 'release/linux-unpacked/mukai';
  const executablePath = resolve(process.argv[2] || defaultExecutable);
  assert.ok(existsSync(executablePath), 'Build the desktop package first.');
  // Refuse to collide with a development or installed copy of Mukai.
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Close Mukai: port 47831 is already in use.')));
    probe.listen(47831, '127.0.0.1', () => probe.close(() => done()));
  });
  const artifactRoot = resolve('artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const directory = mkdtempSync(join(artifactRoot, 'packaged-smoke-'));
  const folder = join(directory, 'workspace');
  mkdirSync(folder);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.MUKAI_DATA_DIR = join(directory, 'data');
  let desktop: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    desktop = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      env,
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) =>
      errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => Boolean((window as unknown as { mukai?: unknown }).mukai));
    const health = await page.evaluate(() =>
      (window as unknown as { mukai: DesktopBridge }).mukai.getHealth(),
    );
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'mukai-api');
    assert.ok(page.url().startsWith('file://'), 'Renderer must load from the packaged app.');
    return page;
  };
  try {
    const page = await launch();
    await page
      .getByRole('heading', { name: 'Create your first workspace.', exact: true })
      .waitFor();
    assert.deepEqual(await workspaceRequest(page), []);
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'visible' });
    const runtime = await desktop!.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule(
        'node:module',
      ) as typeof import('node:module');
      const { join, dirname, sep } = process.getBuiltinModule(
        'node:path',
      ) as typeof import('node:path');
      const { existsSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      const packagedRequire = createRequire(join(app.getAppPath(), 'package.json'));
      const helper =
        process.platform === 'win32'
          ? 'windows.ps1'
          : process.platform === 'darwin'
            ? 'macos'
            : 'linux.py';
      for (const resource of [
        `computer_use/${helper}`,
        'guest/guest.cjs',
        'guest/guest-worker.cjs',
      ])
        if (!existsSync(join(process.resourcesPath, resource)))
          throw new Error(`Missing packaged resource: ${resource}`);
      const sharp = packagedRequire('sharp') as typeof import('sharp').default;
      const image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#12232e' },
      })
        .png()
        .toBuffer();
      if (image.length === 0) throw new Error('Bundled sharp failed.');
      // Resolve from Transformers too: npm may nest the compatibility override.
      const transformerPath = packagedRequire.resolve('@huggingface/transformers');
      const transformerRequire = createRequire(transformerPath);
      const ort = transformerRequire('onnxruntime-node') as {
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
        InferenceSession: {
          create: (
            model: Buffer,
            options: { executionProviders: string[] },
          ) => Promise<{
            run: (inputs: Record<string, unknown>) => Promise<{ y: { data: Float32Array } }>;
            release: () => Promise<void>;
          }>;
        };
      };
      // Hand-authored ONNX Identity graph: float32[2] x -> y, opset 13, IR 7.
      const model = Buffer.from(
        'CAc6OwoQCgF4EgF5IghJZGVudGl0eRIFc21va2VaDwoBeBIKCggIARIECgIIAmIPCgF5EgoKCAgBEgQKAggCQgIQDQ==',
        'base64',
      );
      const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] });
      try {
        const result = await session.run({
          x: new ort.Tensor('float32', new Float32Array([1, 2]), [2]),
        });
        if (result.y.data[0] !== 1 || result.y.data[1] !== 2)
          throw new Error('Bundled ONNX inference failed.');
      } finally {
        await session.release();
      }
      if (typeof packagedRequire('@huggingface/transformers').pipeline !== 'function')
        throw new Error('Bundled Transformers failed to load.');
      const platformPackage = packagedRequire.resolve(
        `@esbuild/${process.platform}-${process.arch}/package.json`,
      );
      process.env.ESBUILD_BINARY_PATH = join(
        dirname(platformPackage),
        process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
      ).replace('.asar' + sep, '.asar.unpacked' + sep);
      const esbuild = packagedRequire('esbuild') as typeof import('esbuild');
      const compiled = await esbuild.transform('const value: number = 1', { loader: 'ts' });
      if (!compiled.code.includes('value')) throw new Error('Bundled esbuild failed.');
      return {
        packaged: app.isPackaged,
        version: app.getVersion(),
        userData: app.getPath('userData'),
      };
    });
    assert.equal(runtime.packaged, true);
    assert.equal(resolve(runtime.userData), join(directory, 'user-data'));
    await verifyUpdater(desktop!, page, directory);
    await page.screenshot({ path: join(directory, 'first-launch.png') });
    const created = await workspaceRequest(page, folder);
    assert.ok(!Array.isArray(created));
    assert.equal(created.name, 'Installer smoke workspace');
    await desktop!.close();
    desktop = undefined;
    const reopened = await launch();
    const saved = await workspaceRequest(reopened);
    assert.ok(Array.isArray(saved));
    assert.ok(
      saved.some((workspace) => workspace.id === created.id),
      'Workspace must survive restart.',
    );
    assert.deepEqual(errors, [], 'Packaged renderer must have no uncaught errors.');
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify({ status: 'passed', runtime }, null, 2) + '\n',
    );
    console.log(
      'Packaged smoke passed: renderer, updater IPC/progress/retry/restart cancellation, SQLite persistence, helpers, sharp, ONNX, esbuild.',
    );
    console.log(`Evidence: ${directory}`);
  } catch (error) {
    const page = desktop?.windows()[0];
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(directory, 'failure.png') });
      console.error('Packaged UI:', await page.locator('body').innerText());
      console.error('Renderer errors:', errors);
      console.error('Evidence:', directory);
    }
    throw error;
  } finally {
    await desktop?.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
