---
name: mukai-api-reference
description: >-
  Use Mukai's existing owner API directly from authenticated websites: discover bots, send and stream chat, read history, stop responses and manage follow-ups without inventing proxy routes.
---

1. For a Mukai-hosted website, register a GET entry route with auth:'session'. After login, browser code calls relative /api/... URLs with credentials:'same-origin'; the owner cookie authenticates these requests. No custom action route or bearer token is needed.
2. Read references/endpoints.md for exact methods, IDs and request bodies. Discover the actual workspace and bot IDs; do not assume the workspace is named default. Encode IDs and query values.
3. Use ordinary JSON for discovery, history and follow-ups. Chat is a stream: use references/browser-client.js for a chunk-safe NDJSON reader and incremental events. Render delta.text, then check the final message/status; do not parse the whole chat response with response.json().
4. Keep one requestId for a chat submission and reuse it for that submission's retries. A 409 can mean the conversation is busy; wait, stop it with user authorization, or queue a follow-up. Do not silently submit a second requestId after an uncertain outcome.
5. On 401, reload the protected entry page to sign in again. Never put Mukai's API token in browser code. MUKAI_ROUTES_TOKEN authorizes workspace custom routes only; terminal/custom-code environments cannot use it for /api/... management requests. Native bot tools remain the normal choice during agent work.
6. Exercise only the requested actions. The owner API can change persistent workspace state; bot tool permissions and browser owner authentication are different access paths.

Server-side fetch does not inherit browser login; credentials:'same-origin' is not server authentication. Custom handlers/jobs/tools should use context.wakeBot. A separate service can POST to an auth:'mukai' custom route that awaits wakeBot, authenticated with its workspace MUKAI_ROUTES_TOKEN. This queues a new private conversation, unlike the primary-chat API. See references/endpoints.md for this boundary.
