import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

const stateSchema = z
  .object({
    pid: z.number().int().positive(),
    instanceId: z.string().uuid(),
    version: z.string(),
    url: z.string(),
    connectionUrl: z.string(),
  })
  .strict();
export type ServerState = z.infer<typeof stateSchema>;
const statePath = (directory: string) => join(directory, 'cli-server.json');
export async function writeServerState(directory: string, state: ServerState) {
  publishServerState(directory, state);
}
export function publishServerState(directory: string, state: ServerState) {
  const temporary = statePath(directory) + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(stateSchema.parse(state)) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, statePath(directory));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the publication error; a partial temporary file is never discoverable.
    }
    throw error;
  }
}
export async function readServerState(directory: string): Promise<ServerState | null> {
  let state: ServerState;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(statePath(directory), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read Mukai server state. Run mukai doctor.', { cause: error });
  }
  const url = new URL(state.url);
  const connectionUrl = new URL(state.connectionUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    connectionUrl.origin !== url.origin ||
    connectionUrl.pathname !== '/' ||
    connectionUrl.search ||
    (connectionUrl.hash !== '' &&
      !/^#mukai-(connect=[a-f0-9]{64}|setup=[a-f0-9]{32})$/.test(connectionUrl.hash))
  )
    throw new Error('Invalid CLI server address. Run mukai doctor.');
  return state;
}
export async function removeServerState(directory: string, instanceId: string) {
  unpublishServerState(directory, instanceId);
}
/** Called before releasing the data lock, so an old shutdown cannot erase a replacement. */
export function unpublishServerState(directory: string, instanceId: string) {
  try {
    const current = JSON.parse(readFileSync(statePath(directory), 'utf8')) as ServerState;
    if (current.instanceId === instanceId) unlinkSync(statePath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function runningServer(directory: string) {
  const state = await readServerState(directory);
  if (!state) return null;
  try {
    if (Number(await readFile(join(directory, 'server.lock'), 'utf8')) !== state.pid) return null;
    process.kill(state.pid, 0);
    const token = (await readFile(join(directory, 'api.token'))).toString('hex');
    const response = await fetch(`${state.url}/api/instance`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const identity = (await response.json()) as { instanceId?: string; version?: string };
    return identity.instanceId === state.instanceId &&
      (identity.version === undefined || identity.version === state.version)
      ? state
      : null;
  } catch {
    return null;
  }
}
