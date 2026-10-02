import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const defaultDataDir = () => process.env.MUKAI_DATA_DIR || join(homedir(), '.mukai');
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
    if (alive) throw new Error('Another Mukai backend is using this data directory.');
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
