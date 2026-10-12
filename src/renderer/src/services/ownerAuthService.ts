export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  verified: boolean;
}
export const authChanged = 'mukai:auth-changed';
export async function authRequest<T>(action: string, value?: unknown): Promise<T> {
  const response = await fetch('/api/auth/' + action, {
    method: value === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(value === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not connect to Mukai. Try again.');
  return result as T;
}
export async function signOut() {
  await authRequest('logout', {});
  window.dispatchEvent(new Event(authChanged));
}
