import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliUpdater } from './updater';
import * as installation from './installation';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const host = { directory: '/fixture', platform: process.platform, arch: process.arch };
const release = {
  version: '0.1.0-build.10.1',
  platform: process.platform,
  arch: process.arch,
  file: 'fixture',
  sha256: 'a'.repeat(64),
};
const prepared = {
  version: release.version,
  root: '/fixture/versions/new/mukai',
  installation: 'new',
};

describe('CLI updater lifecycle', () => {
  it('downloads once, waits for explicit restart, and shuts down timers', async () => {
    vi.useFakeTimers();
    const latest = vi.spyOn(installation, 'latestRelease').mockResolvedValue(release);
    vi.spyOn(installation, 'prepareUpdate').mockImplementation(
      async (_host, _release, progress) => {
        progress(64);
        return prepared;
      },
    );
    const activate = vi.spyOn(installation, 'activateUpdate').mockResolvedValue(prepared.root);
    const restart = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn();
    const updater = new CliUpdater('0.1.0-build.9.1', host, {
      saveAutomaticUpdates: save,
      restart,
    });
    updater.initialize(false);
    expect(updater.check().status).toBe('checking');
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(updater.getState()).toMatchObject({
      status: 'ready',
      version: release.version,
      automaticUpdates: false,
    });
    expect(activate).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    await updater.restart();
    expect(activate).toHaveBeenCalledWith(host, prepared);
    expect(restart).toHaveBeenCalledWith(prepared.root);
    await updater.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('persists the preference before changing timers and allows manual checks when disabled', async () => {
    vi.useFakeTimers();
    const latest = vi
      .spyOn(installation, 'latestRelease')
      .mockResolvedValue({ ...release, version: '0.1.0-build.1.1' });
    const save = vi.fn().mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const updater = new CliUpdater('0.1.0-build.9.1', host, {
      saveAutomaticUpdates: save,
      restart: vi.fn(),
    });
    updater.initialize(true);
    expect(() => updater.setAutomaticUpdates(false)).toThrow('disk full');
    expect(updater.getState().automaticUpdates).toBe(true);
    updater.setAutomaticUpdates(false);
    expect(vi.getTimerCount()).toBe(0);
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(updater.getState().status).toBe('idle');
    await updater.shutdown();
  });
  it('checks after 15 seconds and every four hours, without installing automatically', async () => {
    vi.useFakeTimers();
    const latest = vi
      .spyOn(installation, 'latestRelease')
      .mockResolvedValue({ ...release, version: '0.1.0-build.1.1' });
    const updater = new CliUpdater('0.1.0-build.9.1', host, {
      saveAutomaticUpdates: vi.fn(),
      restart: vi.fn(),
    });
    updater.initialize(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(latest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(latest).toHaveBeenCalledTimes(2);
    await updater.shutdown();
  });
  it('reports failed downloads and permits retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const latest = vi
      .spyOn(installation, 'latestRelease')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue({ ...release, version: '0.1.0-build.1.1' });
    const updater = new CliUpdater('0.1.0-build.9.1', host, {
      saveAutomaticUpdates: vi.fn(),
      restart: vi.fn(),
    });
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.getState()).toMatchObject({ status: 'error', message: 'Offline' });
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toHaveBeenCalledTimes(2);
    expect(updater.getState().status).toBe('idle');
    await updater.shutdown();
  });
  it('keeps unmanaged installations disabled', async () => {
    const save = vi.fn();
    const updater = new CliUpdater('0.1.0', undefined, {
      saveAutomaticUpdates: save,
      restart: vi.fn(),
    });
    updater.initialize(true);
    expect(updater.check().status).toBe('disabled');
    expect(updater.setAutomaticUpdates(false)).toMatchObject({
      status: 'disabled',
      automaticUpdates: false,
    });
    expect(save).toHaveBeenCalledWith(false);
    await updater.restart();
    await updater.shutdown();
  });
});
