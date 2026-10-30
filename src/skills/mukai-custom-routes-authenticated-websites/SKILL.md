---
name: mukai-custom-routes-authenticated-websites
description: Build an authenticated website or dashboard hosted by Mukai, with a button that starts an existing bot through the browser's authenticated Mukai API.
---

1. Write and register one GET /custom/... route with auth:'session' to serve the page. Inline the CSS and JavaScript for a simple website. Mukai hosts it; no terminal-started web server or extra listener is needed.
2. Open the returned host/browser URL. Mukai handles login and returns to the page; existing sessions work immediately. Remote websites must share the HTTPS origin serving Mukai's login and API.
3. The button calls POST /api/bots/{botId}/chat directly from the browser, with credentials:'same-origin', Content-Type: application/json, and {requestId, text:'hi', attachmentIds:[]}. Use the actual target bot ID. The login cookie authenticates the request; no custom POST/action route or relay is needed.
4. See references/bot-api.md for the fetch function. Chat returns streamed NDJSON by default; consume it and handle done/error events. A signed-out API request returns 401; reload the protected page to sign in again.
5. Disable the button while submitting, display the bot's reply or error, and verify login return and the actual message delivery. Never put MUKAI_ROUTES_TOKEN or the master API token in browser JavaScript; neither is needed for this flow.
