# Failed chats and manual retry

**Failed** appears in the navigation rail when at least one chat or pursuit run has a saved `failed` or `interrupted` status. The count and inbox cover **all workspaces**, independently of the selected workspace. Each item identifies its workspace, bot, chat, failure time, and error. Opening it switches workspaces when necessary and opens the original private chat, shared space, bot conversation, or exact pursuit run.

Intentional stops, successful responses, active generations, automatic memory recovery, queued work, and responses awaiting approval are excluded. For normal chats, only the latest assistant response to the latest request counts; an old failure superseded by a new request remains in history. Pursuit failures are tracked per run, including failures before a response could be created.

## Dismissal

An item's **Clear** button dismisses that notice. **Clear all** dismisses every current notice across all workspaces, including pages that have not been loaded. Neither action deletes or changes chats, messages, tool results, pursuit runs, or Workpad entries.

Dismissals are stored separately in `chat_failure_dismissals` and survive restarts. Starting a new response or retry clears that chat's dismissal. A later failure can therefore appear again, even if Retry uses the same saved message ID. A successful or currently running retry disappears from Failed automatically. Opening a notice does not dismiss it.

The inbox derives failure state from existing message/run records rather than copying conversation contents into another event table. It polls the local backend with adaptive intervals and loads 30 notices per page. No VM requests are needed to enumerate failures.

## Retry

Normal chats and spaces use a small shared **Retry response** control. Bot-to-bot chats expose it for the latest unfinished response as well. The authenticated owner retry endpoint selects the original responding bot and saved request without changing the original sender's identity. It does not restart a parent bot that has already received a failed delegated result. Old request IDs still cannot be submitted as human messages to impersonate a bot.

A pursuit run has **Retry run** when it failed, was interrupted, or was deliberately stopped. Retry resumes that same run, conversation, and request; it does not create a new run. Saved model/tool checkpoints and Workpad entries are retained, and completed checkpointed tool calls are not replayed. If a run failed before creating a request, Retry creates its first request in that same run. Retry uses the normal pursuit scheduler and global AI queue. Only one run of a pursuit may be active. The original owning bot must still be available, and an expired deadline must be extended first.

**Run now** remains a fresh pursuit run. Retry is explicit; dismissing a notice never starts work. If a provider/model/tool configuration changed, existing checkpoint validation and review behavior still apply.

## Verification

- `npm test` covers global filtering, pagination, durable dismissal, repeated failures, preserved chat data, authentication, navigation destinations, sender provenance, and same-run pursuit retries with completed tools.
- `npm run test:bots-ui -- --failures-only` exercises the real renderer and disposable backend: global icon, cross-workspace private/space/pursuit navigation, both retry controls, dismissal, and dark/narrow layouts. Run `npx electron-vite build` first.
