import { afterEach, expect, it, vi } from 'vitest';
import { defaultDataDir, desktopDataDir } from './config';

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
