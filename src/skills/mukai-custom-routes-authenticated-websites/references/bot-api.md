Run this in the signed-in page served by the session-protected GET route. Call sayHi with the existing bot's actual ID from the button's click handler. The browser sends its login cookie automatically; no bearer token or custom action endpoint is needed.

```js
async function sayHi(botId, requestId = crypto.randomUUID()) {
  const response = await fetch('/api/bots/' + encodeURIComponent(botId) + '/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, text: 'hi', attachmentIds: [] }),
  });
  if (!response.ok) throw new Error(await response.text());
  // Chat is streamed NDJSON by default. This simple example buffers until done.
  const events = (await response.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const final = events.findLast((event) => event.type === 'done' || event.type === 'error');
  if (!final)
    throw new Error('The response was interrupted; check the saved chat before retrying.');
  if (final.type === 'error') throw new Error(final.message.error || 'Bot response failed.');
  return final.message;
}
```

Disable the button while awaiting sayHi, then display the returned message's content. Handle errors and re-enable the button in finally. If an API request returns 401, reload the protected page to go through Mukai login again. Reuse the same requestId if retrying the same chat submission.
