import { afterEach, expect, it, vi } from 'vitest';
import { defaultDataDir, desktopDataDir } from './config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

afterEach(() => vi.unstubAllEnvs());
it('uses the desktop application name and native data locations on every supported platform', () => {
  expect(
    desktopDataDir('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test'),
  ).toBe('C:\\Users\\test\\AppData\\Roaming\\mukai\\data');
  expect(desktopDataDir('win32', {}, 'C:\\Users\\test')).toBe(
    'C:\\Users\\test\\AppData\\Roaming\\mukai\\data',
  );
  expect(desktopDataDir('darwin', {}, '/Users/test')).toBe(
    '/Users/test/Library/Application Support/mukai/data',
  );
  expect(desktopDataDir('linux', {}, '/home/test')).toBe('/home/test/.config/mukai/data');
  expect(desktopDataDir('linux', { XDG_CONFIG_HOME: '/custom/config' }, '/home/test')).toBe(
    '/custom/config/mukai/data',
  );
  expect(desktopDataDir('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/test')).toBe(
    '/home/test/.config/mukai/data',
  );
});
it('retains the explicit data-directory environment override', () => {
  vi.stubEnv('MUKAI_DATA_DIR', 'custom-data');
  expect(defaultDataDir()).toBe('custom-data');
});

it.each([1, 2, 3, 4, 5])(
  'allows only one process to reclaim a stale data lock, and releases the OS lease after a crash (attempt %i)',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukai-data-lock-'));
    const previous = spawn(process.execPath, ['-e', '']);
    await once(previous, 'exit');
    await writeFile(join(directory, 'server.lock'), String(previous.pid));
    const script = `
const { acquireDataLock } = require(${JSON.stringify(resolve('src/server/config.ts'))});
try {
  const release = acquireDataLock(process.argv[1]);
  process.on('message', () => { release(); process.disconnect(); });
  process.send({ owned: true });
} catch (error) {
  process.send({ owned: false, message: error.message });
  process.disconnect();
}`;
    const children = Array.from({ length: 2 }, () =>
      spawn(process.execPath, ['--import', 'tsx', '-e', script, directory], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      }),
    );
    const exited = children.map((child) => once(child, 'exit'));
    try {
      const messages = await Promise.all(
        children.map(
          async (child) =>
            (await once(child, 'message', { signal: AbortSignal.timeout(5000) }))[0] as {
              owned: boolean;
            },
        ),
      );
      expect(
        messages.filter((message) => message.owned),
        JSON.stringify(messages),
      ).toHaveLength(1);
      const winner = children[messages.findIndex((message) => message.owned)];
      winner.kill('SIGKILL');
      await Promise.all(exited);
      // A killed owner leaves a stale PID file, but the kernel releases its lease.
      const { acquireDataLock } = await import('./config');
      const release = acquireDataLock(directory);
      release();
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(exited);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
