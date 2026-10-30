# Owner API quick reference

These paths are for the web server that serves Mukai. A same-origin signed-in browser sends its HttpOnly owner cookie with credentials:'same-origin'. This is not the scope of MUKAI_ROUTES_TOKEN. Do not read or distribute the master API token to implement a browser page.

Use GET /api/workspaces to discover workspace IDs. The local/VM runtime and custom-route URL are not a management API credential.

| Method and path                                              | Body / result                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /api/workspaces                                          | Workspace array, including id, name and computer.                                                                                                                      |
| GET /api/bots?workspaceId=WORKSPACE_ID                       | Bot array; choose an actual id from this workspace.                                                                                                                    |
| GET /api/bots/BOT_ID/messages                                | Saved messages in the bot's primary private chat, not every conversation involving that bot.                                                                           |
| POST /api/bots/BOT_ID/chat                                   | {requestId: UUID, text: string, attachmentIds: []}; streams chat events.                                                                                               |
| POST /api/bots/BOT_ID/stop                                   | Empty body or {}; stops the active response in the bot's primary private chat. Previously completed effects remain.                                                    |
| GET /api/bots/BOT_ID/followups                               | Pending follow-ups for its primary private chat.                                                                                                                       |
| POST /api/bots/BOT_ID/followups                              | {id: UUID, text: string, attachmentIds: []}; queues a follow-up that may run when idle; returns the pending queue array with 201. id is a follow-up ID, not requestId. |
| PUT /api/bots/BOT_ID/followups                               | {action:'edit',id,text,attachmentIds?}, {action:'delete',id}, or {action:'send',id}. Send is an explicit action, not merely saving a draft.                            |
| POST /api/bots/BOT_ID/conversations                          | Creates a new private conversation for that existing bot; use the returned id.                                                                                         |
| GET /api/conversations?workspaceId=WORKSPACE_ID&kind=private | Private conversations; kind can also be bot or space.                                                                                                                  |
| GET /api/conversations/CONVERSATION_ID/messages              | Saved messages for the selected conversation.                                                                                                                          |
| POST /api/conversations/CONVERSATION_ID/chat                 | For a private or bot chat: {requestId,text,attachmentIds:[]}. Streams events in that conversation.                                                                     |
| POST /api/conversations/CONVERSATION_ID/stop                 | Empty body or {}; stops the selected conversation.                                                                                                                     |
| GET /api/conversations/CONVERSATION_ID/outputs               | Saved output metadata for that conversation.                                                                                                                           |

Replace placeholders and encode each ID with encodeURIComponent. Use URLSearchParams for filters. /api/bots/BOT_ID/chat uses the primary chat; use the conversation endpoint when the user chose another conversation. Shared spaces have a separate botId-aware contract; inspect that contract before using it.

## Minimal browser calls

Copy references/browser-client.js into the page's JavaScript (or adapt its functions):

```js
const bots = await mukaiJson('/api/bots?' + new URLSearchParams({ workspaceId }));
const bot = bots.find((item) => item.id === selectedBotId);
if (!bot) throw new Error('Select a bot from this workspace.');
const requestId = crypto.randomUUID(); // retain this for retries of this submission
const message = await mukaiChat(bot.id, 'hi', {
  requestId,
  onEvent(event) {
    if (event.type === 'delta') output.textContent += event.text;
  },
});
// message.status is complete, failed, stopped, or interrupted; show what actually happened.
```

Queue a message without starting a competing primary-chat request:

```js
const id = crypto.randomUUID();
const queue = await mukaiJson('/api/bots/' + encodeURIComponent(botId) + '/followups', {
  method: 'POST',
  body: { id, text: 'Check the result when ready.', attachmentIds: [] },
});
```

Queueing a follow-up can start it automatically when the chat is idle; it is not a saved draft or evidence of completion. Read the queue/history to observe its state. Reusing the same follow-up id with different content is a conflict.

## Chat response format

Default: application/x-ndjson, one JSON event per line. A network chunk may split a line or a UTF-8 character; retain the incomplete tail with a streaming TextDecoder. Incremental delta events have text. start includes user/assistant messages; activity, reasoning, context and part events are additional state. done and error carry the final message. HTTP 200 alone does not prove a successful run; errors can arrive in the stream.

Accept: text/event-stream selects SSE instead. SSE has data: lines, blank event separators and colon-prefixed keepalives; do not feed its framing to an NDJSON parser. The supplied helper deliberately requests NDJSON.

Aborting/disconnecting can affect an active response. If the stream ends before done/error, check saved history before retrying with the same requestId. Do not infer exactly-once external effects from a transport retry. JSON endpoints return {error:...} on errors; handle 401 (sign in), 403 (access/origin), 404 (wrong ID/path), and 409 (busy/conflict) according to their message.

Source contracts: src/server/http/routes.ts, src/server/http/schemas.ts, src/server/http/transport.ts and src/shared/ai.ts in the Mukai repository. Recheck these when extending this reference.
