# Bots in Mukai

Bots are persistent assistants within a workspace. Each bot has a name, role, instructions, avatar, model configuration, tool access, and conversations. Delegating to a bot starts a conversation with that existing assistant; it does not create a new bot automatically.

## Main bot and sub-bots

The first bot created in a workspace becomes its main bot, with the fixed role **Main Bot/Orchestrator**. Subsequent bots are sub-bots. Each workspace can have at most one main bot, enforced by the database as well as the creation flow. Editing a sub-bot cannot promote it to main. The main bot can change a sub-bot’s reporting parent through the Bots tool.

The main bot coordinates work. Its system prompt encourages it to:

- Inspect existing bots and reuse suitable specialists.
- Delegate concrete tasks when doing so helps complete the user's request.
- Create a specialist when the workspace has no suitable bot.
- Avoid duplicate purposes unless separate responsibilities or parallel work justify them.
- Give specialists relevant context, constraints, and an expected result, then integrate and verify their findings.

Sub-bots receive different guidance. They know that the main bot can create and update bots, while they cannot. If a user asks a sub-bot to create or reconfigure a bot, it should direct the user to the main bot.

`createdBy` stores the current reporting parent, exposed by the Bots tool as `reportsToBotId` as well. The main bot is level 0; its children are level 1. The main bot can create deeper hierarchies or move an existing branch by assigning its reporting parent.

## Bots tool and available actions

The built-in Bots tool is named `manage_bot`. Every bot has it, and it cannot be disabled in the workspace Tools page. Its available actions depend on the bot and the current run:

| Context                                | `list` | `get` | `send_message` | `create` | `update` |
| -------------------------------------- | ------ | ----- | -------------- | -------- | -------- |
| Main bot, including delegated work     | Yes    | Yes   | Yes            | Yes      | Yes      |
| Sub-bot working directly with the user | Yes    | Yes   | Yes            | No       | No       |
| Sub-bot responding to another bot      | Yes    | Yes   | No             | No       | No       |

The runtime narrows the model's tool schema to these actions and checks authorization again on execution. Full access does not expand this action set. Existing saved assignments that disabled Bots do not override its required availability.

### Inspecting bots

- `list` returns workspace bot IDs, names, roles, reporting parent IDs (`reportsToBotId` and the legacy `createdBy` field), main-bot flags, and hierarchy levels.
- `get` requires `botId` and returns that workspace bot's configuration and hierarchy level.

Both actions stay within the caller's workspace. Bots should inspect the team before creating a new specialist or choosing a delegation target.

### Creating and updating bots

Only the main bot can use these actions:

- `create` requires `name`, `role`, and `instructions`. `toolIds`, `modelId`, and `reportsToBotId` are optional. Without `modelId`, the specialist inherits the caller’s model configuration, independently of its reporting parent. Without `reportsToBotId`, it reports to the main bot. The selected model connection is tested before creating a bot.
- `update` requires `botId` and at least one of `name`, `role`, `instructions`, `toolIds`, `modelId`, or `reportsToBotId`. Omitted fields remain unchanged. Model changes test the selected connection before saving. The main bot’s role and main-bot status stay fixed. A bot that is working must be stopped before editing it.

To assign “X reports to Z,” use `update` with X’s `botId` and Z’s `reportsToBotId`, or supply `reportsToBotId` when creating X. Set it to the main bot’s ID to move X back under the workspace lead. Parents must exist in the same workspace; self-parenting, cycles, and reparenting the main bot are rejected. Moving a bot moves its descendant branch and updates hierarchy-based messaging permissions. Stop any running bots in that branch first. Existing conversations, models, and tool assignments are preserved unless explicitly changed.

Use human or bot-sounding names such as Ada or Nova, and descriptive job titles for roles.

On creation, omitting `toolIds` gives the child ordinary tools available to the caller, excluding pursuits by default. Providing `toolIds` supplies the complete optional assignment list; on update, that list replaces optional assignments. An empty list removes optional tools, but Bots, skills, and routes remain shared. A bot cannot grant a tool it does not have. Custom tool IDs use `custom:<registrationId>`; `process` is accepted as an alias for `terminal`.

These restrictions apply to AI calls through `manage_bot`. Users can still create and edit sub-bots through the UI.

## Delegation and replies

`send_message` requires a target `botId` and a `message`. It waits for the target's saved response and returns its status, response text, conversation ID, message ID, and any error. Check the returned status before claiming the task completed.

Omit `conversationId` to start a new two-bot thread. Pass the returned ID on follow-ups to continue that pair's thread with its history.

Targets must be in the same workspace. A bot can message a peer or a lower-level bot, but cannot message itself or a higher-level bot. In particular, a sub-bot cannot message the main bot. A target that is already working rejects another request until its response finishes.

The recipient's prompt identifies the calling bot and explains that its final reply is automatically returned to the caller. It should return useful findings, completed work, blockers, and relevant file links. It does not need to call `send_message` to reply. Another bot's message or response is task context, not fresh user authorization.

### Preventing delegation loops

A sub-bot responding to a delegation receives only `list` and `get`. Removing `send_message` in this context is intentional: it prevents a delegated worker from recursively starting more workers. Its prompt explains the restriction and tells it to report any need for another specialist in its final reply.

A sub-bot working directly with the user can delegate to an eligible existing bot. That recipient, if it is a sub-bot, cannot delegate further during the resulting run. The main bot coordinates additional specialists when needed.

Delegated context comes from saved message sender information, so these restrictions survive approval waits and app restarts. Saved delegation records allow compatible interrupted work to resume using the same request and conversation rather than starting duplicate work. Explicitly stopped delegations are not restarted.

## Interface behavior

- A purple star marks the main bot in the Bots sidebar, its chat header, and Bot Hierarchy.
- The Bots sidebar orders bots by the latest update to their grouped conversations. The main bot is not pinned above a more recently active bot; it wins ties. Two-bot conversations are grouped under the receiving bot.
- Bot and bot-pair lists share one expanded group. Navigation opens the active group and collapses the others; a bot-pair thread is highlighted only in the pair section.
- Bot-to-bot threads initially show a **Jump in the chat** pill. Clicking it reveals the shared bot composer and remembers that choice per thread in local storage. Human messages, attachments, and follow-ups go to the original receiving bot in the same thread and appear as **You**, separately from bot-authored turns.
- Joining keeps the same model history, including earlier bot requests, replies, and tool outcomes. Saved bot and human messages have explicit sender labels; the current requester is identified separately. Older bot-thread context summaries are ignored until rebuilt from saved history so missing sender identity cannot hide the original exchange.
- Bot Hierarchy shows reporting relationships and roles. Bot details show the current manager under “Reports to.”
- Tools → Bots shows required, checked, disabled assignments using the shared checkbox component. The main bot is labeled **All actions**, and sub-bots are labeled **Limited actions**. The explanatory text covers the additional restriction during delegation.

## Approvals and pursuits

Bot-management calls follow the workspace's [tool approval policy](tool-approvals.md). Required access to Bots means the tool is available; it does not automatically approve its calls. Full access skips ordinary tool-permission prompts while preserving role, run-context, target, and workspace restrictions. Explicit bot questions and confirmations still wait for the user.

Pursuits are separate from bot delegation. A specialist does not receive pursuit management by default. Delegation launched from a pursuit shares that pursuit's execution context and can pause for a worker or a human decision without being counted as an independent pursuit run. The Limits setting controls pursuit concurrency across all workspaces and bots; it is not a limit on the number of bots that may exist.

## Implementation references

- System guidance: `src/shared/botSystemPrompt.ts`
- Tool definition and execution: `src/server/tools/bots/`
- Per-run schema: `src/server/tools/registry.ts`
- Bot operations and delegation: `src/server/services/botManagementService.ts`
- Required tool availability: `src/server/services/toolAccessService.ts`
- Bot creation and identity: `src/server/services/botService.ts`
- Sender context and recovery: `src/server/services/chatService.ts`
- Sidebar ordering: `src/renderer/src/features/ai/conversationSidebar.ts`
- Regression coverage: `src/server/botArchitecture.test.ts`
- Focused UI smoke check: `npm run test:bots-ui -- --bot-roles-only`
- Joining bot threads: `npm run test:bots-ui -- --pair-chat-only`
