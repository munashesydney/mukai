/* global fetch, crypto, TextDecoder */
// Browser module for a page on the same origin as Mukai; never add a bearer token.
async function checked(response) {
  if (response.ok) return response;
  if (response.status === 401) throw new Error('Sign in to Mukai by reloading the protected page.');
  const detail = await response.text();
  throw new Error(`Mukai HTTP ${response.status}: ${detail}`);
}

export async function mukaiJson(path, { method = 'GET', body, signal } = {}) {
  if (!path.startsWith('/api/')) throw new Error('Use a relative Mukai /api/ path.');
  const response = await checked(
    await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
  return response.status === 204 ? null : response.json();
}

export async function mukaiChat(
  botId,
  text,
  { requestId = crypto.randomUUID(), attachmentIds = [], signal, onEvent = () => {} } = {},
) {
  const response = await checked(
    await fetch('/api/bots/' + encodeURIComponent(botId) + '/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ requestId, text, attachmentIds }),
      signal,
    }),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The chat response stream is unavailable.');
  const decoder = new TextDecoder();
  let buffer = '';
  let final;
  function dispatch(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message.error || 'The bot response failed.');
    if (event.type === 'done') final = event.message;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        dispatch(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) {
        dispatch(buffer);
        break;
      }
    }
    if (!final) throw new Error('Chat was interrupted; check saved history before retrying.');
    return final;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
