import { EventEmitter } from 'node:events';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopUpdater } from './desktopUpdater';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(enabled = true) {
  const events = new EventEmitter();
  const download = deferred<string[]>();
  const checkForUpdates = vi.fn(async () => {
    events.emit('update-available', { version: '0.1.0-build.13.1' });
    return { downloadPromise: download.promise } as UpdateCheckResult;
  });
  const native = Object.assign(events, { checkForUpdates, quitAndInstall: vi.fn() });
  const options = {
    notify: vi.fn(),
    confirmRestart: vi.fn(async () => true),
    prepareQuit: vi.fn(async () => {}),
    disabledReason: 'Installed releases only.',
  };
  const manager = new DesktopUpdater(
    enabled ? (native as unknown as AppUpdater) : undefined,
    '0.1.0-build.12.1',
    options,
  );
  return { events, native, manager, options, download };
}

afterEach(() => vi.useRealTimers());

it('follows published latest releases and never downgrades or installs on ordinary quit', () => {
  const { native } = fixture();
  expect(native).toMatchObject({
    channel: 'latest',
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: true,
    autoInstallOnAppQuit: false,
  });
});

it('keeps development and unsupported packages offline', async () => {
  vi.useFakeTimers();
  const { manager, native } = fixture(false);
  manager.start();
  manager.check();
  await manager.restart();
  await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(manager.getState().status).toBe('disabled');
  expect(native.checkForUpdates).not.toHaveBeenCalled();
  expect(native.quitAndInstall).not.toHaveBeenCalled();
});

it('deduplicates checks through download and preserves a ready update until restart', async () => {
  const { manager, native, events, download } = fixture();
  manager.check();
  manager.check();
  events.emit('download-progress', { percent: 42.8 });
  expect(manager.getState()).toMatchObject({ status: 'downloading', percent: 42 });
  events.emit('update-downloaded', { version: '0.1.0-build.13.1' });
  download.resolve(['installer.exe']);
  await vi.waitFor(() => expect(manager.getState().status).toBe('ready'));
  manager.check();
  expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(native.quitAndInstall).not.toHaveBeenCalled();
});

it('waits for consent and completed shutdown before installing, even on repeated clicks', async () => {
  const { manager, native, events, options } = fixture();
  await manager.restart();
  expect(options.confirmRestart).not.toHaveBeenCalled();
  events.emit('update-downloaded', { version: '0.1.0-build.13.1' });
  options.confirmRestart.mockResolvedValueOnce(false);
  await manager.restart();
  expect(manager.getState().status).toBe('ready');
  expect(options.prepareQuit).not.toHaveBeenCalled();
  const shutdown = deferred<void>();
  options.prepareQuit.mockReturnValueOnce(shutdown.promise);
  const restart = manager.restart();
  await vi.waitFor(() => expect(options.prepareQuit).toHaveBeenCalledTimes(1));
  await manager.restart();
  expect(native.quitAndInstall).not.toHaveBeenCalled();
  shutdown.resolve();
  await restart;
  expect(native.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
});

it('catches check and download failures so later checks can retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { manager, native, download } = fixture();
  native.checkForUpdates.mockRejectedValueOnce(new Error('Offline'));
  manager.check();
  await vi.waitFor(() => expect(manager.getState().status).toBe('error'));
  manager.check();
  download.reject(new Error('Bad checksum'));
  await vi.waitFor(() => expect(manager.getState().status).toBe('error'));
  expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(native.quitAndInstall).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('checks after startup and periodically, and cancels timers on shutdown', async () => {
  vi.useFakeTimers();
  const { manager, native, download, events } = fixture();
  native.checkForUpdates.mockImplementation(async () => {
    events.emit('update-not-available', { version: '0.1.0-build.12.1' });
    return {} as UpdateCheckResult;
  });
  download.resolve([]);
  manager.start();
  manager.start();
  await vi.advanceTimersByTimeAsync(14999);
  expect(native.checkForUpdates).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
  manager.stop();
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
});
