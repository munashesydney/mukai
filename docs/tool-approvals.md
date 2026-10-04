# Tool approvals (V1)

One setting applies to every bot and conversation in every workspace, including scheduled pursuit runs and custom capability wake-ups. It is stored in the installation database's metadata, independent of a bot or conversation.

- **Ask for approval** pauses before each tool invocation, including reads, workspace tools, runtime tools, skills, management tools, and custom tools. Built-in memory functions (add, search, forget) always run without approval.
- **Full access** runs permitted tools without an approval prompt. Existing tool assignments and workspace boundaries still apply.

V1 deliberately has no “Approve for me” mode. Full access remains the default to preserve the execution behavior of existing installations. Selecting Ask for approval immediately governs subsequent invocations, including in running conversations.

The central chat execution wrapper requests approval before calling the tool or marking its side effects as started. Each request describes the bot, tool, and exact arguments. Approve grants only that invocation; Reject returns a rejection result to the model without executing the tool. Calls from the same model step share a batch ID and appear in an accordion with individual decisions and an **Approve all** button. Bulk approval grants only the IDs shown when clicked; later calls remain pending. The server validates the entire batch belongs to one conversation and model step before granting anything.

Pending approval cards appear above bot and space composers and in pursuit run views, exclusively in the conversation that triggered them. Background requests can be found through the bot's Pending Approvals page. The dropdown opens upward and changes the shared server policy, not a local or per-chat preference.

Bots with requests across any of their conversations show a **Pending Approvals** sidebar tab with an animated gradient border (static when reduced motion is enabled). Its page links every request to its exact private chat, space, or pursuit run. The Bots rail dot reflects outstanding requests; Spaces has no static notification dot. Requests include an authenticated server-derived destination, so pursuit links open the correct run instead of the pursuit overview.

Mentioning a bot in a space starts it normally. The bot's tool calls obey the same approval policy as other conversations, including the memory exception. The approval selector and workspace picker share `PopupMenu`, including their floating surface, keyboard navigation, focus handling, and viewport positioning.

The model's next step waits for the tool decision. Provider response timeouts exclude human approval wait time. A disconnected UI does not grant or discard approval; the pending requests can be recovered through authenticated `GET /approvals`. Stop, shutdown, and a failed provider step cancel pending requests. Server restarts interrupt incomplete responses and discard pending grants; Retry needs fresh approval. Changing to Full access does not implicitly approve existing cards.

Authenticated API endpoints:

- `GET /approvals`: global mode and all pending requests.
- `PUT /approvals` with `{ "mode": "ask-for-approval" | "full-access" }`: persist the global mode.
- `POST /approvals/:id` with `{ "approved": true | false }`: resolve exactly one live request. Expired or duplicate decisions return 409.
- `POST /approvals/batch` with `{ "conversationId", "batchId", "ids": [...], "approved": true | false }`: resolve an explicit snapshot of pending calls from one model step. Mixed or stale batches return 409 without granting any calls; empty or duplicate IDs return 400.

Implementation plan: central persisted policy and cancellable gate → authenticated approval API → shared renderer state, dropup, and cards → stop/reconnect/timeout behavior → regression tests covering real SDK workspace and custom-tool dispatch.
