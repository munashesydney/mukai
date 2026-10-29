import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Match Electron's default app.getPath('userData')/data without requiring Electron in the CLI. */
export function desktopDataDir(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
) {
  if (platform === 'win32')
    return win32.join(
      environment.APPDATA || win32.join(userHome, 'AppData', 'Roaming'),
      'mukai',
      'data',
    );
  if (platform === 'darwin')
    return posix.join(userHome, 'Library', 'Application Support', 'mukai', 'data');
  const configHome = environment.XDG_CONFIG_HOME;
  return posix.join(
    configHome && posix.isAbsolute(configHome) ? configHome : posix.join(userHome, '.config'),
    'mukai',
    'data',
  );
}
export const defaultDataDir = () => process.env.MUKAI_DATA_DIR || desktopDataDir();
export function privateSecret(dir: string, name: string, bytes: number) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(bytes);
    try {
      writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      return readFileSync(path);
    }
    return value;
  }
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function acquireDataLock(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'server.lock');
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('The data directory lock is invalid.');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive)
      throw new Error(
        `Another Mukai backend is already using this data directory (pid ${pid}). Run the other ` +
          'UI against that backend instead — `npm run dev:web` proxies to it — or give this one ' +
          'its own directory with MUKAI_DATA_DIR / --data-dir.',
      );
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
