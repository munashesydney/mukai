# Tool approvals (V1)

One setting applies to every bot and conversation in every workspace, including scheduled pursuit runs and custom capability wake-ups. It is stored in the installation database's metadata, independent of a bot or conversation.

- **Ask for approval** pauses before each tool invocation, including reads, workspace tools, runtime tools, skills, management tools, and custom tools. Built-in memory functions (add, search, forget) always run without approval.
- **Full access** runs permitted tools without an approval prompt. Existing tool assignments and workspace boundaries still apply to file operations. The `image` family accepts absolute local image paths outside the workspace in either mode; Ask for approval gates the exact invocation before file access.

V1 deliberately has no “Approve for me” mode. Full access remains the default to preserve the execution behavior of existing installations. Selecting Ask for approval immediately governs subsequent invocations, including in running conversations.

The central chat execution wrapper requests approval before calling the tool or marking its side effects as started. Each request describes the bot, tool, and exact arguments. Approve grants only that invocation; Reject returns a rejection result to the model without executing the tool. Calls from the same model step share a batch ID and appear in an accordion with individual decisions and an **Approve all** button. Bulk approval grants only the IDs shown when clicked; later calls remain pending. The server validates the entire batch belongs to one conversation and model step before granting anything.

Pending approval cards appear above bot and space composers and in pursuit run views, exclusively in the conversation that triggered them. Background requests can be found through the bot's Pending Approvals page. The dropdown opens upward and changes the shared server policy, not a local or per-chat preference.

The built-in [ask tool](ask-tool.md) shares this pending flow. Its clarification action shows suggestions, exactly one recommendation, and a free-text answer field. Its approval action shows Approve and Deny. Explicit questions always wait for the user, including in Full access, and do not receive a redundant tool-permission prompt. Clarifications cannot be approved through a boolean decision or a bulk grant. User answers are saved atomically with removal of the pending card, so a resolved question is not repeated during restart recovery.

Bots with requests across any of their conversations show a **Pending Approvals** sidebar tab with an animated gradient border (static when reduced motion is enabled). The page groups all requests from the same conversation into one compact row and links to the exact private chat, space, or pursuit run. The Bots rail dot reflects outstanding requests; Spaces has no static notification dot. Requests include an authenticated server-derived destination, so pursuit links open the correct run instead of the pursuit overview.

Mentioning a bot in a space starts it normally. The bot's tool calls obey the same approval policy as other conversations, including the memory exception. The approval selector and workspace picker share `PopupMenu`, including their floating surface, keyboard navigation, focus handling, and viewport positioning.

The model's next step waits for the tool decision. Provider response timeouts exclude human approval wait time. Pending requests and the current step's tool inputs and completed outputs are stored in SQLite. Closing and reopening the app restores the same cards, IDs, batches, conversation, and pursuit run. Waiting responses stay pending rather than becoming Interrupted. Recovery executes the exact approved inputs before asking the model to continue; completed results are reused. An operation marked as started without a saved output receives an uncertain-result record and is never automatically replayed. If the tool/model configuration changed, recovery fails with a fresh-review message rather than executing an outdated call. Changing to Full access does not implicitly approve existing cards.

A disconnected UI can recover pending requests through authenticated `GET /approvals`. Stop and failed provider steps cancel requests and remove their durable records. Shutdown preserves waiting requests; responses without a pending approval still become interrupted and can be retried. Animated activity icons are clipped within fixed-size containers to keep their rotation from changing scroll bounds.

Authenticated API endpoints:

- `GET /approvals`: global mode and all pending requests.
- `PUT /approvals` with `{ "mode": "ask-for-approval" | "full-access" }`: persist the global mode.
- `POST /approvals/:id` with `{ "approved": true | false }`: resolve exactly one live request. Expired or duplicate decisions return 409.
- `POST /approvals/:id` with `{ "answer": "..." }`: answer one live clarification with a suggested choice or custom text (1–16000 trimmed characters). Approval requests require a boolean instead.
- `POST /approvals/batch` with `{ "conversationId", "batchId", "ids": [...], "approved": true | false }`: resolve an explicit snapshot of pending calls from one model step. Mixed or stale batches return 409 without granting any calls; empty or duplicate IDs return 400.

Implementation plan: central persisted policy and cancellable gate → authenticated approval API → shared renderer state, dropup, and cards → stop/reconnect/timeout behavior → regression tests covering real SDK workspace and custom-tool dispatch.
