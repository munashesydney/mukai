import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

declare const __MUKAI_VERSION__: string;

export function version() {
  if (typeof __MUKAI_VERSION__ !== 'undefined') return __MUKAI_VERSION__;
  return (
    JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
}
export function runtimePaths() {
  const installedRoot = resolve(__dirname, '..');
  const installed = existsSync(join(installedRoot, 'manifest.json'));
  const root = installed ? installedRoot : resolve(__dirname, '../..');
  return {
    root,
    installed,
    webDir: join(root, installed ? 'web' : 'dist/web'),
    guestBundleDir: join(root, installed ? 'resources/guest' : 'dist/guest'),
    desktopHelperDir: join(root, installed ? 'resources/computer_use' : 'dist/computer_use'),
  };
}
