import type { DesktopBridge } from '../../../shared/contracts';
import { authChanged } from './ownerAuthService';

let connection: Promise<{ url: string; token: string }> | undefined;
export async function apiWebSocketUrl(path: string) {
  const config = window.mukai
    ? await (connection ??= window.mukai.getApiConnection())
    : { url: '/api', token: '' };
  const url = new URL(config.url + path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
/**
 * Last answer per polled path, so a body-less 304 can be served without
 * re-reading or re-parsing megabytes of unchanged JSON. Entries are keyed by the
 * exact path (query included) and the server decides identity, so a mutation
 * that changes a read's content simply produces a new ETag on the next poll.
 */
const MAX_REVALIDATED = 16;
const revalidated = new Map<string, { etag: string; value: unknown }>();

/** Map insertion order doubles as recency order. */
function remember(path: string, entry: { etag: string; value: unknown }) {
  revalidated.delete(path);
  revalidated.set(path, entry);
  while (revalidated.size > MAX_REVALIDATED) {
    const oldest = revalidated.keys().next().value;
    if (oldest === undefined) break;
    revalidated.delete(oldest);
  }
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const bridge = window.mukai as DesktopBridge | undefined;
  const config = bridge
    ? await (connection ??= bridge.getApiConnection())
    : { url: '/api', token: '' };
  const headers = new Headers(init.headers);
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  if ((init.method || 'GET').toUpperCase() === 'GET') {
    const held = revalidated.get(path);
    // Holding a validator turns "send this to me again" into "has this changed?".
    if (held) headers.set('If-None-Match', held.etag);
  }
  let response: Response;
  try {
    response = await fetch(config.url + path, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new Error('Cannot reach Mukai’s server. Start the backend and try again.');
  }
  // 304 is the successful answer to a revalidation, and carries no body to read.
  if (!response.ok && response.status !== 304) {
    if (response.status === 401 && !bridge && !import.meta.env.DEV)
      window.dispatchEvent(new Event(authChanged));
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `The request failed (${response.status}).`);
  }
  return response;
}
export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method,
    ...(value === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  });
  if (response.status === 304) {
    const held = revalidated.get(path);
    // Returning the same reference is what lets callers skip a rebuild outright.
    if (held) return held.value as T;
    // The validator outlived its body (evicted mid-flight); re-read without it.
    return (await (await apiFetch(path, { method })).json()) as T;
  }
  const parsed = (await response.json()) as T;
  const etag = response.headers.get('ETag');
  if (etag) remember(path, { etag, value: parsed });
  else revalidated.delete(path);
  return parsed;
}

