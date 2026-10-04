# Tool approvals (V1)

One setting applies to every bot and conversation in every workspace, including scheduled pursuit runs and custom capability wake-ups. It is stored in the installation database's metadata, independent of a bot or conversation.

- **Ask for approval** pauses before each tool invocation, including reads, workspace tools, runtime tools, memory, skills, management tools, and custom tools.
- **Full access** runs permitted tools without an approval prompt. Existing tool assignments and workspace boundaries still apply.

V1 deliberately has no “Approve for me” mode. Full access remains the default to preserve the execution behavior of existing installations. Selecting Ask for approval immediately governs subsequent invocations, including in running conversations.

The central chat execution wrapper requests approval before calling the tool or marking its side effects as started. Each request describes the bot, tool, and exact arguments. Approve grants only that invocation; Reject returns a rejection result to the model without executing the tool. Parallel calls each require their own decision.

Pending approval cards appear above bot and space composers. They also appear in pursuit run views; other conversations' pending requests remain visible so background jobs can be resolved. The dropdown opens upward and changes the shared server policy, not a local or per-chat preference.

The model's next step waits for the tool decision. Provider response timeouts exclude human approval wait time. A disconnected UI does not grant or discard approval; the pending requests can be recovered through authenticated `GET /approvals`. Stop, shutdown, and a failed provider step cancel pending requests. Server restarts interrupt incomplete responses and discard pending grants; Retry needs fresh approval. Changing to Full access does not implicitly approve existing cards.

Authenticated API endpoints:

- `GET /approvals`: global mode and all pending requests.
- `PUT /approvals` with `{ "mode": "ask-for-approval" | "full-access" }`: persist the global mode.
- `POST /approvals/:id` with `{ "approved": true | false }`: resolve exactly one live request. Expired or duplicate decisions return 409.

Implementation plan: central persisted policy and cancellable gate → authenticated approval API → shared renderer state, dropup, and cards → stop/reconnect/timeout behavior → regression tests covering real SDK workspace and custom-tool dispatch.
