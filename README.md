# Mukai

**Wake up to what’s possible.** Mukai means “wake up” in Shona. An Electron workspace built with React and TypeScript.

Bots, chats, spaces, pursuits, workspaces, artifacts, and tools use a local Node backend, SQLite, and the Vercel AI SDK. Bots can create specialists and delegate work within their workspace hierarchy.

## Run

For the standalone terminal command and production browser mode, see [Mukai CLI](docs/cli.md). The CLI and desktop share this application's renderer and backend.

Requires **Node.js 24 LTS** and npm. The desktop bundles its own Electron runtime.

```sh
npm ci
npm run dev
```

The Electron app starts its backend at `http://127.0.0.1:47831` using a fixed local port. Custom routes share this server, so their URLs stay stable across restarts (for example, `http://127.0.0.1:47831/custom/events`). Port 47831 must be available; startup fails if it is already in use. Add your first bot from the empty workspace; suggested names start with **Mukai** and **Scout**. Provider setup can wait until after bot creation. Sending without a provider opens **Settings → Providers**. Add OpenAI, Anthropic, Google, or an OpenAI-compatible endpoint, enter an exact chat model ID, and use **Save & test**. The first provider becomes the default used by bots without an explicit connection. Connection tests make a small billable request for paid providers.

Provider inactivity and generation deadlines pause during tool execution and human approvals. Temporary provider failures can recover automatically before any action or visible answer starts in that step; completed earlier steps stay saved. Recovery is bounded per model step and respects Stop. If a response cannot finish, Mukai provides a saved-progress report and marks unresolved operations for verification before repeating them. Memory extraction starts with up to 12,000 output tokens within the configured model allowance; compatible providers get one repair attempt with a fresh two-minute deadline, within a four-minute operation limit. A failed memory save returns an error to the bot so it can still report completed work.

To use a ChatGPT plan, add **ChatGPT subscription** and choose **Continue with ChatGPT**. Complete sign-in and authorize plan usage in your system browser. Eligible Plus and Pro accounts can use their included usage through the official Sign in with ChatGPT flow; it shares their ChatGPT Work/Codex and per-app limits. Identity-only sign-in is retained, but requires enabling plan usage before inference. Choose an account-specific model, set its documented context window when OpenAI does not supply it, confirm image support, and save. The same grouped model picker is available in bot settings. Families are GPT, Codex, o-series Reasoning, and Other; missing capabilities are not guessed. Refresh the catalog when account permissions or available models change.

Each ChatGPT connection retains its own verified identity and issued OAuth client ID. Adding another account creates a separate connection even if emails match. Reconnect reuses that registration and this installation’s stable host ID. Access/refresh/ID tokens stay encrypted in the backend and are never returned to the renderer. Refreshes are serialized; revoked tokens require reconnecting, while temporary renewal failures retain credentials. Disconnect stops active ChatGPT inference and attempts remote revocation, then clears local tokens while retaining the account registration. If revocation cannot be confirmed, disconnect Mukai in ChatGPT Settings too. Review app limits and credits in ChatGPT Settings → Usage. Mukai does not silently switch billing providers when a limit is reached.

ChatGPT plan inference uses only the public Responses endpoint, with `store: false`, explicit history, streaming, and namespaced locally executed tools. Connection tests and context summaries also use streaming on the wire. The current preview rejects output-token caps: the **Output reserve** setting budgets local context but does not cap the model’s actual output. Hosted image generation, file search, Code Interpreter, native computer use, hosted MCP, audio/video, and upload/transcription APIs are not enabled through this connection. Local Mukai tools remain separate from those hosted capabilities. Sign-in opens a temporary callback listener on `127.0.0.1`; it validates state, PKCE, signed identity, audience, expiry, nonce, and returning-account identity. Attempts expire after five minutes and can be cancelled. App shutdown closes pending listeners.

This integration follows OpenAI’s [open-source client guide](https://developers.openai.com/siwc/token-sharing-open-source) and [preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Availability remains subject to the account, workspace policy, OpenAI’s rollout, and the app’s eligibility for that flow.

For browser development, run these in separate terminals:

```sh
npm run dev:server
npm run dev:web
```

Open http://127.0.0.1:5173. Vite proxies `/api` to the authenticated service on port 47831. The server reads process environment variables, not `.env` files. Set `PORT` to change the standalone port and update the proxy target to match. The desktop app uses port 47831 regardless of `PORT`; run desktop and standalone modes separately because they share the same default port.

Local OpenAI-compatible servers can use a base URL such as `http://127.0.0.1:11434/v1` or `http://127.0.0.1:1234/v1`. Install a chat model in your local server first and enter its exact ID. Keys are optional for endpoints without authentication. Remote custom endpoints require HTTPS. Standard text chat and streaming chat-completions compatibility are required.

## What works

- **Settings → Domain** saves the public HTTPS base URL for all custom routes across workspaces. Leave it blank to use `http://127.0.0.1:47831`. Changes apply immediately and persist across restarts; no environment variable or `.env` file is needed. Configure your domain or tunnel separately to forward `/custom/*` to the local server.

- Temporal graph memory lives in the independent [`mukai_memory`](mukai_memory/README.md) module. **Settings → Memory** provides a graph/list inspector, source evidence, corrections, forgetting, recall records, and import/export. New user statements are captured in the background using the configured AI, and relevant confirmed memories are supplied before each reply. Private chat memories stay private to their bot; spaces use workspace memory. Keyword/relationship retrieval works immediately; **Download & enable** installs local CPU BGE embeddings. Capture and recall can be disabled per workspace.

- Create a workspace from a local folder using the workspace menu. The desktop has a native folder picker; browser development accepts an absolute local path. Each workspace starts with no bots. Pursuits, spaces, tools, and settings unlock after its first bot is created. Provider connections are shared across workspaces.
- The first bot is the main bot and starts with every tool. Later bots start without Bots or pursuits. When bots create children, omitted `toolIds` grants available ordinary tools, excluding Bots and pursuits; an explicit list replaces that default. **Tools → Workspace tools** and **Custom tools** offer per-bot assignments; skills and routes stay shared. Revocations are checked when a tool executes, including during an active response.
- **Pursuits → Workpad** holds the owner bot’s current work items, decisions, blockers, references, and notes. Entries can link to workspace files, public URLs, conversations, artifacts, and related entries. The `manage_pursuit` actions `list_entries`, `get_entry`, `add_entry`, and `update_entry` provide paginated retrieval and revision-checked updates. Entries save immediately, survive failed runs and restarts, and record their author and originating run. Every wake receives a bounded digest that balances blockers, active work, decisions, and recent results. Bots are strongly encouraged to maintain useful state; entries remain optional and an empty Workpad never prevents a run from finishing. The user view supports type/status filters, archives, linked-entry inspection, conversation previews, artifact downloads, and copying file paths.
- **Settings → Limits** configures the shared pursuit pool: five concurrent runs by default across all bots and workspaces, adjustable from 1 to 50. Waiting for a human approval or answer releases a slot; continuations queue for capacity before resuming, including after a restart. Lowering the limit lets current work finish.
- Tool approval mode is scoped to the current workspace. Tool approval cards include **Enable Full Access Mode** with an accessible help tooltip. It changes the same workspace policy as the approval picker; existing pending calls and explicit bot confirmations still need a response. `report_pursuit` runs automatically in either mode.
- Every bot has a required role; the main bot uses **Main Bot/Orchestrator**. Give specialists names such as Ada or Nova and put job titles such as Code architect in their role. The bot editor and `manage_bot` creation both require a role, and the Bots sidebar displays names only.
- Select the model beside the chat composer to change that bot's saved provider/model for its next response. ChatGPT connections offer their account model catalog; other providers accept an exact model ID and context window. Selecting the provider default clears the bot's model override without changing the provider's settings.
- The `manage_bot` workspace tool has `create`, `list`, and `send_message` actions. Creation stores `createdBy`, inherits provider/model settings, and grants only tools the caller can use. `send_message` returns the actual response, status, and `conversationId`; passing that ID continues the two-bot thread, while omitting it creates a new one. Bots may message peers or lower-level bots, including across branches, but cannot message themselves, higher-level bots, or another workspace’s bots. The recipient receives the sender’s name and role, and its final reply returns automatically to the caller. Stopping the caller stops delegated work. Delete children before their parent.
- **Spaces → Bot conversations** groups saved threads by bot pair with both avatars. Expand a pair to open any of its conversations in the standard Bots message display. These conversations are read-only for users and have no composer. **Bot Hierarchy** follows nested `createdBy` relationships as sub-bots create their own children.
- Each bot can have multiple private conversations. SQLite saves user messages, assistant messages, partial responses, and file references. Switching bots does not stop an active stream.
- Private and bot-to-bot conversations use their own history and compact older context when needed. Spaces supply their latest **10 usable messages, including the current user message**. Bot instructions and the exact current request remain intact. Original history stays visible after compaction.
- Streaming Markdown, stop generation, and retry of the latest failed, stopped, or interrupted response. Backend-owned runs survive switching chats, refreshing, and disconnected UI streams. Reconnecting the same request attaches to its existing run. Stop explicitly cancels it. Bot delegations persist the exact child request before starting work and automatically reconnect after a backend restart, including nested delegations and pending approvals. Other interrupted work uses Retry to resume a compatible completed-step checkpoint. Uncertain operations are never automatically replayed.
- While a bot works, type and send a text follow-up to queue it above the composer. **Steer** applies a queued message to the active task; edit and delete remain available before delivery. This works through Mukai's runtime with every supported provider, without a native model steering API. Text-only generations can be interrupted and continued with saved progress; tools, delegated work, and pending human decisions reach their existing boundary before a correction applies. Applied corrections appear in response activity and remain in context through retries and compaction. Queues survive refresh and backend restarts. Successful responses start queued messages in order; Stop or a failed response pauses the queue until you explicitly send a queued item or complete another response. Follow-ups support text, up to twenty pending messages per conversation; attachments use the regular composer after generation finishes.
- Each `send_message` activity includes an **Open bot conversation** button. Child permission requests also appear in every ancestor chat waiting on that response, labeled with the requesting sub-bot’s name. Approving or rejecting from either chat resolves the same request; grouped approvals remain scoped to the child’s actual conversation.
- Collapsing **Worked for** shows applied steering as ordinary user messages above the bot reply, with the steering timestamp and a steer icon after it. Expanding keeps those messages in the chronological work transcript. Pending guidance extends the current task at its next safe boundary, including the end of a model pass; guidance reaching an already completed task is delivered once as a normal follow-up.
- If a model ends without final text, Mukai asks for a final reply up to twice with tools disabled, retaining completed results and user answers. Each recovery adds a runtime continuation after the saved results and omits previous model reasoning from that request, while preserving the original checkpoint. Recovery attempts and successful recovery are informational log entries; exhausted attempts remain errors. Invalid tool inputs are warnings, followed by an informational entry when corrected input returns a result. An existing safety pause still stops the run.
- The composer shows provider-reported input/output usage when available and clearly labels estimates otherwise. Context capacity is supplied in model settings; custom bot models can override it. Automatic compaction preserves complete tool-call/result pairs and retains a working notebook. Failed summaries leave usable context and original history untouched.
- Provider settings, encrypted keys, connection tests, workspace defaults, and explicit model/image capability settings. Saved key values are never sent back to the UI or written to logs.
- Persistent image previews, file downloads, and an Artifacts view for uploaded files and drafts created by bots. Pending uploads are recovered after refresh. Generated artifacts preview/download the current workspace file; moving or editing that file outside Mukai affects what is available.
- Model-provided reasoning streams into a collapsible Thinking card and persists with the response. It is available only when the selected provider/model returns reasoning or a reasoning summary; Mukai does not invent private model thoughts.
- File Operations is available to assigned bots with a connected workspace folder. Bots can list, read, write, patch, search, and create directories. Tool activity and action counts are visible in chat and Tools. Stop replaces Send during generation and cancels further work; completed file changes remain on disk.
- Unsent text drafts and their retry IDs survive refresh in device storage; accepted messages remain authoritative in SQLite.
- Existing themes, navigation, bot search, native window controls, and the current Mukai design.

## Attachments and limits

Up to **4 files per message**, **10 MB per file**. Supported images: PNG, JPEG, WebP. Enable image support only for a model that actually supports vision; text-only models reject new image attachments before saving/sending the turn. Older images are described by filename if you later switch that bot to a text-only model.

PDF, DOCX, and common UTF-8 text/code files are extracted to text for chat models. The original files remain downloadable. PDF extraction reads the first 20 pages; scanned PDFs need OCR elsewhere. Document formatting and embedded images are not sent. Extracted text is limited to 24,000 characters per file, with any extraction/truncation notice shown before sending. DOCX archives also have expanded-size and entry-count limits. Legacy `.doc`, spreadsheets, audio/video, executables, and arbitrary binary files are unsupported.

Message text is limited to 16,000 characters; bot instructions to 12,000. Model output defaults to 8,192 tokens per generation and is configurable. Effective output is capped at an eighth of the configured context, then reduced further when necessary to leave input and output within a 90% working target. Output exhaustion is separate from context exhaustion: a truncated generation gets up to three consecutive continuations. There is no total run time or cumulative-token cap. A single provider generation retains a three-minute timeout and a 45-second idle timeout. Emergency ceilings allow 1,000 generations and 2,000 operations per tool family. Repeated identical requests/results trigger a warning, then a controlled pause with a final report; process polling and successful browser interactions are treated conservatively. Normal browser state changes reset repetition detection, and rotating snapshot references do not count as progress.

Context compaction is recorded inline in response activity as “Compacting context”, then “Context compacted” (or failed/interrupted). Boundaries survive reload and appear inside the completed work disclosure. Summary requests are tool-free; empty or truncated output gets bounded retries with more output room and tighter summary instructions, and DeepSeek chat/flash thinking is disabled for summaries. Original history and the previous usable context are preserved until the entire compaction succeeds.

Recent tool groups are retained only when they fit beside the exact current request, instructions, and summary. Summary size scales down for smaller contexts. All tool families share a model-facing result limiter: parallel results share one allowance of up to 45% of configured context, reduced for required instructions and the current request. Oversized text/JSON preserves its beginning and ends with an explicit truncation notice; files and commands themselves are unchanged. Bounded serialization handles circular, deeply nested, and extremely large results. Screenshots are estimated from PNG dimensions and provider usage; images that cannot fit are explicitly omitted, with page snapshots or smaller results suggested. Binary transport also has a context-dependent 2–16 MiB shared ceiling to keep working checkpoints bounded. Historical image pixels are excluded from summary prompts while recorded observations remain available. Token counts are estimates until calibrated by provider usage, so a configured context too small for the mandatory request and tool definitions still produces a clear error.

Set the exact model context-window size when adding a provider or choosing a different bot model. Existing models without a saved size show “unknown” and use a conservative 32,768-token working budget until configured. Estimates use UTF-8 text size, image allowances, tool definitions, and provider usage calibration; they are not an exact tokenizer for every model. Very large pinned requests or tool results produce a clear recoverable error rather than silent truncation. Provider context windows, account permissions, quotas, and model availability still apply. File actions require a model/endpoint that supports tool calling; reasoning requires a model/endpoint that returns it.

File Operations works with UTF-8 text files up to 256 KB, returns at most 200 lines/24,000 characters per read, and bounds searches to 5,000 entries and 100 matches. Paths are relative to the selected folder. Traversal, links/junctions, hard-linked files, Mukai’s private data, `.git`, common credential folders, `.env*`, and key files are blocked. New writes refuse existing files unless overwrite is explicit; patches require exactly one match. There are no shell, delete, or move actions. File edits do not have automatic undo; retries preserve previous tool activity and instruct the model to check completed operations before repeating writes. Use a project folder whose contents you intend your bots and selected provider to access.

## Persistence and security

Custom tools and routes use saved `.ts`/`.js` modules on the existing Node backend. The Tools page retains built-in tools and adds Custom tools and Routes sections with registration, inspection, live updates, testing, and recent runs. Settings → Environment variables stores encrypted, workspace-scoped configuration. Bots can register modules and call them on the next model step without a new conversation. See [the module contracts, examples, runtime limits, and webhook setup](docs/custom-capabilities/README.md).

Desktop and CLI use the same per-user data directory: `%APPDATA%/mukai/data` on Windows, `~/Library/Application Support/mukai/data` on macOS, and `${XDG_CONFIG_HOME:-~/.config}/mukai/data` on Linux. The lowercase folder name matches Electron's application name and existing desktop installations. Set **`MUKAI_DATA_DIR`** for another location, or use CLI **`--data-dir`**. Run one backend per data directory. Older standalone data in `~/.mukai` is preserved and can still be selected explicitly.

Appearance is saved in the existing `app_settings` table, alongside the public custom-route URL. The Limits tab's pursuit concurrency is also saved in SQLite. On the first updated desktop launch, its previous appearance preference is imported from local storage only if no shared appearance exists. Browser local storage is only a startup cache; shared preferences override it across browser ports and desktop launches.

Failure diagnostics are written as one JSON record per line in `<data directory>/logs/errors.log` and printed in the backend terminal with `[mukai diagnostic]`. They include timestamps, a diagnostic ID, model/provider and conversation/message IDs, failure phase, HTTP status, provider error type/code/message, nested network causes, and filtered stack frames when available. API keys and the local API token are redacted; request bodies, prompts, tool arguments, raw validation payloads, full response bodies, and authorization headers are not serialized. The current file rotates at 2 MiB, keeping `errors.1.log` and `errors.2.log`. If writing fails, terminal diagnostics remain available and chat handling continues. Logging covers chat/provider exceptions, compaction recovery errors, SDK tool failures, provider connection tests, unexpected HTTP errors, and checkpoint/response-save failures. Earlier failures cannot be reconstructed retroactively.

The directory holds `mukai.sqlite`, its WAL files, durable `uploads/`, `credentials.key`, and `api.token`. Credentials use AES-256-GCM with a local random encryption key. Files use private permissions where the OS supports them and inherit the current user’s directory permissions on Windows. This is a single-user local app, not a remotely hosted multi-user service. The encryption key lives beside the database; anyone with access to the complete data directory can decrypt saved credentials. Protect that directory and back up the whole directory after shutting down the server.

The backend binds only to `127.0.0.1`, authenticates feature APIs with a local bearer token, checks Host/Origin, rejects credential-bearing custom URLs, and does not follow provider redirects. Electron exposes only a narrow typed preload bridge with context isolation, sandboxing, denied permissions, and CSP. The renderer receives a local API token, never provider credentials. Chat context and supported attachment contents go directly to your selected provider. OpenAI Responses requests explicitly disable response storage; each provider’s own retention policies still apply.

Migrations are append-only, versioned, and transactional in `src/server/db/migrations.ts`, tracked in `schema_migrations`. Scout’s one-time seed is tracked separately so deleting it does not recreate it on restart. Startup marks unfinished assistant records interrupted.

## Structure

```text
src/
  main/                       Electron lifecycle and restricted IPC
  preload/                    Typed desktop bridge
  shared/                     Public API/chat/provider contracts
  server/
    app.ts                    Composition, dependency wiring, server lifecycle
    db/                       SQLite connection, transactions, versioned migrations
    repositories/             Workspace, bot, provider, message, attachment/artifact data
    services/                 Business rules, credentials, AI chat, confined file operations
    tools/
      registry.ts             Typed definitions, SDK adapters, all/selected-bot scopes
      file-operations/
        definition.ts         Bundled action schema and model-facing description
        execute.ts            Execution and persisted activity/artifact callbacks
    models/                   Internal records and explicit public projections
    http/                     Routes, request validation, auth, NDJSON transport
    config.ts                 Local paths and secrets
    index.ts                  Standalone service lifecycle
  renderer/src/
    app/                      Application composition
    components/               Shared shell and UI components
    services/                 Typed workspace/bot/provider/chat/artifact/tool API calls
    models/                   Renderer chat state and drafts
    features/ai/              Bot UI, chat state coordination, attachment presentation
    features/settings/        Workspace, Appearance, Providers
    features/workspace/       Workspace creation, tool catalog, prototype areas
    styles/                   Theme tokens and component styles
```

Server dependencies run from **HTTP → services → repositories → SQLite**. Repositories map SQL rows into typed internal records; services own business rules and project private records into the shared public contracts. HTTP handlers have no SQL, and AI streaming is independent of Node HTTP through a small output interface. `app.ts` constructs the dependencies explicitly.

On the client, components and chat state call typed services rather than building URLs or parsing streams. `services/http.ts` owns authentication and transport errors; `services/chatService.ts` owns the NDJSON reader. Shared request/response types remain in `shared/`, while `renderer/src/models/` contains UI-specific state. ESLint enforces the main import boundaries.

Each tool has its own folder with a Zod definition and executor. `registry.ts` adapts definitions to the AI SDK and supports `all-bots` or `selected-bots` with explicit bot IDs. Services supply the workspace, cancellation, activity, and artifact context. Add future tools through this registry rather than embedding tool implementations in chat or HTTP routes.

## Telegram

Open **Telegram** in the navigation rail to connect a dedicated bot from
[@BotFather](https://t.me/BotFather). The guided setup validates the token, creates
a five-minute one-time pairing link, and asks you to approve the exact Telegram
account in Mukai. Claiming the link alone grants no access. Choose the workspaces
to enable and use each workspace’s main bot or select a specific bot.

In your bot’s private Telegram chat, send `/workspaces` and select a workspace.
Text messages then use a dedicated, persistent Mukai conversation. Switching
workspaces resumes its conversation; `/new` creates a fresh one and `/stop`
cancels the selected conversation’s response and queued messages. Conversations
remain available in the desktop/browser app. Attachments and group chats are not
supported in this version. Tool approvals still happen in Mukai according to the
workspace’s existing approval settings.

The existing backend owns one long poller, a durable SQLite inbox, a separate AI
turn queue, and a rate-limited outbound queue. It requires no webhook, public
endpoint, or extra worker deployment. Mukai must be running and the computer
awake; the standalone CLI/backend can also host the connection. Use only one
poller per Telegram bot. A bot with an existing webhook must be disconnected
from that integration before Mukai can connect; Mukai never removes it silently.

Replies use Telegram’s streaming drafts when available and persist a final text
answer; otherwise a typing indicator accompanies the final reply. Long answers
are split into messages. Reasoning, raw tool outputs, and approval payloads are
not forwarded. Incoming messages are deduplicated and queued against their
original workspace/conversation. Access is checked again before execution and
delivery. Interrupted AI/tool executions are not automatically replayed after
a restart, and ambiguous outbound sends are marked uncertain rather than sent
again. Review the saved conversation and Telegram chat before retrying those.

Tokens use the existing local AES-256-GCM credential key and never return in API
responses or logs. Pairing secrets are stored only as hashes; numeric Telegram
identity and signed workspace callbacks enforce account and workspace access.
Pause, revoke the paired account, or disconnect the bot from the Telegram tab.
Disconnecting removes the saved token and pairing/session data while preserving
Mukai conversations. As with provider credentials, protect the complete local
data directory, which also holds the encryption key. Telegram carries the chat
text in addition to the AI provider you configured.

`npm run test:telegram-ui` runs the production Electron renderer against a
disposable real Mukai backend and a test-only Telegram transport. It covers the
interactive setup, explicit account approval, workspace/bot selection, connection
controls, keyboard focus, and light/dark/narrow layouts. Build the app first.
Backend tests under `src/server/telegram/` cover access isolation, durable routing,
recovery, cancellation, transport sanitization, and the shared AI runtime.

## Workspace skills

Tools → Skills manages reusable workflow folders. Create or edit `SKILL.md` (YAML `name` and `description`, followed by instructions), add supporting text files, or preview an import from a public GitHub file/folder URL. Imports preserve references, scripts, licenses, and binary assets, record a pinned commit, and validate all files before saving. Exported JSON bundles can be imported again. Files live in Mukai’s workspace-scoped SQLite store; importing never executes scripts or installs dependencies.

The `skills` tool supports search, inspect, load/unload, read, create/update, import, enable/disable, and remove. Bots receive a small enabled-skill catalog and load full instructions only as needed. Loaded versions are pinned per bot/conversation, persist across restarts and compaction, and are removed when the skill is disabled or deleted. Updates require the inspected version to avoid overwriting concurrent edits. Reload to use updated instructions; `read` returns the current file version and supports paging text or base64 assets. Use file operations to save required supporting files into the workspace before running a script.

A folder is limited to 100 files and 8 MB. Symlinks, submodules, unsafe paths, duplicate paths, malformed frontmatter, and invalid blob integrity are rejected. Loaded instructions are limited to three skills and a model-aware context budget (at most 24 KB); the catalog is separately bounded. Skills cannot grant tools or override the user’s instructions. Required connectors and dependencies must be configured separately. Public GitHub imports use its unauthenticated API and may hit its rate limit; private repositories are not supported.

`npm run test:skills-ui` exercises the production Electron renderer against a disposable workspace, including creation, editing, supporting files, import preview, search, availability, removal, and light/dark/narrow layouts. Run `npm run build` first.

## Verification and builds

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
npm run preview
```

Integration tests use the actual AI SDK against a **test-only local OpenAI protocol fixture** and disposable SQLite databases. They cover credentials/redaction, context limits and compaction failures, output continuation, reported/estimated token usage, bot-specific instructions/models, restart checkpoints and uncertain operations, disconnected streams, stop/retry, attachments, deletion, API authentication, workspace isolation, streamed reasoning/tool calls, generated artifacts, file boundaries, and database upgrades. The Electron smoke test also exercises context settings, composer usage, and persisted model settings in the production renderer. Production provider adapters always call the selected real endpoint; no fixture or canned reply is connected to the app.

`npm run build` produces Electron output in `out/` and the standalone service in `dist/server/`. Run the compiled service with `npm run start:server`. `/health` remains public and supports GET/HEAD.

```sh
npm run package     # Unpacked desktop app in release/
npm run dist        # Platform installer
npm run dist:win    # Windows x64 setup wizard (local build, never publishes)
npm run test:packaged # Smoke-test the packaged app with disposable data
```

The Windows installer is written to `release/Mukai-Setup-<version>-x64.exe`. It
installs for the current Windows user, with a welcome page, installation folder
selection, an optional desktop shortcut, progress, and an option to launch Mukai
on the Finish page. A Start menu shortcut and Windows Installed apps entry are
created automatically. Uninstalling keeps saved Mukai data so reinstalling can
reuse it. The installer bundles Electron/Node and works without a separate Node
installation or a running development server; AI providers and optional downloads
still need their usual network access and setup.

For a local test, close any development copy of Mukai before launching the
installed app: both use port 47831. Check first launch, workspace folder selection,
provider setup/chat, saved settings after restarting, shortcuts, and uninstall.
The local build is unsigned, so Windows may show an unknown-publisher warning.

## Automated desktop and CLI releases

`.github/workflows/release.yml` builds Windows x64, macOS Intel/Apple Silicon,
and Linux x64 on their native GitHub runners. Pull requests build and smoke-test
all desktop and CLI packages without publishing, then validates the real filenames,
sizes, and checksums together. Every successful push to `main` publishes
desktop installers, CLI archives, installation scripts, `cli-manifest.json`, and `SHA256SUMS.txt` together in a GitHub Release. Failed checks,
missing packages, failed uploads, and superseded commits do not replace the latest
published release. A failed upload can leave a draft release for diagnosis.

Builds use `<package version>-build.<workflow run number>.<attempt>` so every
release has distinct filenames and a traceable version. This version is applied
only in CI; the source package and lockfile are not committed by the workflow.
The workflow uses its own repository's `GITHUB_TOKEN`, with write permission only
in the publish job. No personal access token or cross-repository secret is needed.
Keep this repository public for unauthenticated website downloads.

The separate `mukai-web` repository reads the latest published release at runtime
and refreshes its download buttons within approximately two minutes, without a
website commit or rebuild. The website repository can remain private. Deploy
its release-download integration once to enable this behavior.

`onnxruntime-node` is overridden to `1.23.2`, which includes Intel macOS native
binaries. The `1.30.0` dependency supplied by Transformers lacks `darwin/x64`
binaries. Keep this compatibility pin until upstream restores that platform;
packaged smoke checks run actual CPU inference and load Transformers on all
four targets. The application's quantized BGE embedding and cached offline
inference have also been verified with this version.

Actions can also run the **Desktop release** workflow manually: builds always run,
and the **publish** checkbox allows publishing only when the selected branch is
`main`. Main and manually dispatched Mac builds use Developer ID signing,
hardened runtime, Apple notarization, and stapled tickets. CI verifies the
signature, Team ID, ticket, and Gatekeeper assessment before uploading an installer.
PR builds use ad-hoc signing and receive no Apple credentials.

Set repository Actions secrets `MAC_CSC_LINK` (base64-encoded Developer ID
Application `.p12`), `MAC_CSC_KEY_PASSWORD` (its export password), `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Credentials are injected only
into the Mac signing step; missing credentials fail the release rather than
silently creating an unsigned Mac app. Manual runs on trusted feature branches
can validate signing without publishing. Keep `.p12` files and private keys out
of Git.

Windows publisher signing and installed-app updates are still deferred.
Cloud sync, user accounts, and OCR are not included. Pursuit scheduling
runs while the local backend is running.
