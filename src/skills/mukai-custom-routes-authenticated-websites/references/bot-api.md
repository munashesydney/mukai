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

## Server-side callers

The API is not intrinsically browser-only: a server client with valid owner authentication can call it. However, the browser example relies on its owner's session cookie. A separate Node/Python service or custom handler does not automatically have that cookie, and server-side credentials:'same-origin' does not obtain it. Mukai strips Cookie/Authorization before invoking authenticated custom handlers. MUKAI_ROUTES_TOKEN is a workspace custom-route credential, not an owner management API credential. Do not extract browser cookies or the master token to make this example work in custom server code.

Inside a custom route, tool or job, use await context.wakeBot('hi',{botId:'EXISTING_BOT_ID'}) directly. For a separate service, create/register a POST /custom/... route with auth:'mukai'; its handler validates the requested action, awaits context.wakeBot and returns an acknowledgment. The service POSTs to MUKAI_ROUTES_URL plus that path with Authorization: Bearer using MUKAI_ROUTES_TOKEN. Keep the target within the registration owner's permitted workspace bots. A browser-facing custom action route can instead use auth:'session' when owner login is the intended authentication.

wakeBot durably queues a wake in a new private conversation; it does not post into the bot's primary chat or return a streamed bot reply like POST /api/bots/{botId}/chat. Its accepted result means queued, not completed. The direct browser approach above still needs only the GET entry route.
