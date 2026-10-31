import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

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

export class DataDirectoryInUseError extends Error {
  constructor() {
    super('Another Mukai backend is using this data directory.');
  }
}

export function acquireDataLock(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lease: DatabaseSync | undefined;
  try {
    // SQLite's OS lock is released even after a crash. It also serializes stale
    // PID-file recovery: two launchers can never unlink each other's new lock.
    lease = new DatabaseSync(join(dir, 'server-lease.sqlite'));
    // Concurrent first opens can briefly hold SQLite initialization locks.
    // Allow those to settle before deciding another backend owns the lease.
    lease.exec('PRAGMA busy_timeout = 250; BEGIN EXCLUSIVE;');
    const releasePid = acquirePidLock(dir);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        releasePid();
      } finally {
        lease!.close();
      }
    };
  } catch (error) {
    lease?.close();
    const code = (error as { errcode?: number }).errcode;
    if (code !== undefined && [5, 6].includes(code & 0xff)) throw new DataDirectoryInUseError();
    throw error;
  }
}

/** Retained alongside the OS lease for discovery and older Mukai releases. */
function acquirePidLock(dir: string) {
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
    if (alive) throw new DataDirectoryInUseError();
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DataDirectoryInUseError();
    throw error;
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
