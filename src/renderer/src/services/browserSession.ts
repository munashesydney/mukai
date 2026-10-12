/** Connect before mounting the application; the long-lived API token never enters the browser. */
export async function initializeBrowserSession() {
  if (window.mukai) return;
  if (import.meta.env.DEV) return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('mukai-connect');
  if (token)
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const response = await fetch('/api/session', {
    method: token ? 'POST' : 'GET',
    ...(token
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }
      : {}),
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error('Open the connection link printed by mukai serve or mukai status.');
}
