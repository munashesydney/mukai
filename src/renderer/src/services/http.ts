import type { DesktopBridge } from '../../../shared/contracts';

let connection: Promise<{ url: string; token: string }> | undefined;
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
