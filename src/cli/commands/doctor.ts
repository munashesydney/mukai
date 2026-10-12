import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimePaths, version } from '../runtime';
import { runningServer } from '../serverState';

export async function doctor(dataDir: string) {
  const paths = runtimePaths();
  const helper =
    process.platform === 'win32'
      ? 'windows.ps1'
      : process.platform === 'darwin'
        ? 'macos'
        : 'linux.py';
  const checks = [
    ['Node 24 or newer', Number(process.versions.node.split('.')[0]) >= 24],
    ['Browser UI', existsSync(join(paths.webDir, 'index.html'))],
    ['VM guest bundle', existsSync(join(paths.guestBundleDir, 'guest.cjs'))],
    ['Computer-use helper', existsSync(join(paths.desktopHelperDir, helper))],
  ] as const;
  console.log(
    `Mukai ${version()} · ${process.platform}/${process.arch}\nRuntime: ${process.execPath}\nInstallation: ${paths.root}\nData: ${dataDir}`,
  );
  for (const [name, passed] of checks) console.log(`${passed ? 'OK' : 'MISSING'}  ${name}`);
  console.log((await runningServer(dataDir)) ? 'Server: running' : 'Server: stopped');
  console.log(
    'Chrome is required for Chrome browser tools. VM setup and native desktop permissions are configured separately in Mukai.',
  );
  return checks.every(([, passed]) => passed) ? 0 : 1;
}
