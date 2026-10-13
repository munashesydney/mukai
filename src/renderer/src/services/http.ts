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
export async function apiFetch(path: string, init: RequestInit = {}) {
  const bridge = window.mukai as DesktopBridge | undefined;
  const config = bridge
    ? await (connection ??= bridge.getApiConnection())
    : { url: '/api', token: '' };
  const headers = new Headers(init.headers);
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  let response: Response;
  try {
    response = await fetch(config.url + path, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new Error('Cannot reach Mukai’s server. Start the backend and try again.');
  }
  if (!response.ok) {
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
  return response.json() as Promise<T>;
}
