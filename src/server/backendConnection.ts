import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { DataDirectoryInUseError } from './config';
import { runningServer, type ServerState } from './backendState';

export interface BackendConnection {
  state: ServerState;
  token: string;
}

/** The port is an address, not an identity. Only the selected directory is searched. */
export async function discoverBackend(
  dataDir: string,
  expectedVersion: string,
): Promise<BackendConnection | null> {
  const state = await runningServer(dataDir);
  if (!state) return null;
  if (state.version !== expectedVersion)
    throw new Error(
      `Mukai ${state.version} is already running for ${dataDir}, but this client is ${expectedVersion}. Update both to the same version, or stop the running backend and try again.`,
    );
  const token = (await readFile(join(dataDir, 'api.token'))).toString('hex');
  return { state, token };
}

/** A losing launcher waits for the lock owner to finish initialization; it never steals its lock. */
export async function startOrConnectBackend<T>(
  dataDir: string,
  version: string,
  start: () => Promise<T>,
  startupTimeout = 30_000,
): Promise<{ owned: true; api: T } | { owned: false; connection: BackendConnection }> {
  const existing = await discoverBackend(dataDir, version);
  if (existing) return { owned: false, connection: existing };
  try {
    return { owned: true, api: await start() };
  } catch (error) {
    if (!(error instanceof DataDirectoryInUseError)) throw error;
    const deadline = Date.now() + startupTimeout;
    do {
      const connection = await discoverBackend(dataDir, version);
      if (connection) return { owned: false, connection };
      try {
        // The winning launcher may have failed during initialization and released its lock.
        return { owned: true, api: await start() };
      } catch (retryError) {
        if (!(retryError instanceof DataDirectoryInUseError)) throw retryError;
      }
      await setTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error(
      `A Mukai backend owns ${dataDir}, but did not become ready. Check its terminal or quit the older desktop app, then run mukai doctor.`,
      { cause: error },
    );
  }
}
