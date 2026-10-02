# Mukai

**Wake up to what’s possible.** Mukai means “wake up” in Shona. An Electron workspace built with React and TypeScript.

Bots and their chats now use a real local Node backend, SQLite, and the Vercel AI SDK. Spaces, Pursuits, and Tools retain their earlier UI prototype behavior; autonomous work and integrations are outside this feature.

## Run

Requires **Node.js 24 LTS** and npm. The desktop bundles its own Electron runtime.

```sh
npm ci
npm run dev
```

The Electron app starts its backend on a random loopback port. Go to **Settings → Providers**, add OpenAI, Anthropic, Google, or an OpenAI-compatible endpoint, enter an exact chat model ID, and use **Save & test**. The first provider becomes the workspace default; Scout uses that default unless you edit its model settings. Connection tests make a small billable request for paid providers.

For browser development, run these in separate terminals:

```sh
npm run dev:server
npm run dev:web
```

Open http://127.0.0.1:5173. Vite proxies `/api` to the authenticated service on port 4318. The server reads process environment variables, not `.env` files. Set `PORT` to change the standalone port and update the proxy target to match.

Local OpenAI-compatible servers can use a base URL such as `http://127.0.0.1:11434/v1` or `http://127.0.0.1:1234/v1`. Install a chat model in your local server first and enter its exact ID. Keys are optional for endpoints without authentication. Remote custom endpoints require HTTPS. Standard text chat and streaming chat-completions compatibility are required.

## What works

- Scout is created once on first setup. Create, edit, and delete additional bots with their own name, description, instructions, provider, model, and identity.
- Each bot has one continuous chat. SQLite saves user messages, assistant messages, partial responses, and file references. Switching bots does not stop an active stream.
- Every response includes the bot’s instructions and its latest **10 usable chat messages, including the current user message**. Empty failed assistant records are excluded; older history stays visible.
- Streaming Markdown, loading states, stop generation, and retry of the latest failed, stopped, or interrupted response. Retries reuse the same user and assistant records. Refreshing during a response interrupts that stream and leaves a retryable saved turn.
- Provider settings, encrypted keys, connection tests, workspace defaults, and explicit model/image capability settings. Saved key values are never sent back to the UI or written to logs.
- Persistent image previews, file downloads, and a chat attachments view. Pending uploads are recovered after refresh.
- Unsent text drafts and their retry IDs survive refresh in device storage; accepted messages remain authoritative in SQLite.
- Existing themes, navigation, bot search, native window controls, and the current Mukai design.

## Attachments and limits

Up to **4 files per message**, **10 MB per file**. Supported images: PNG, JPEG, WebP. Enable image support only for a model that actually supports vision; text-only models reject new image attachments before saving/sending the turn. Older images are described by filename if you later switch that bot to a text-only model.

PDF, DOCX, and common UTF-8 text/code files are extracted to text for chat models. The original files remain downloadable. PDF extraction reads the first 20 pages; scanned PDFs need OCR elsewhere. Document formatting and embedded images are not sent. Extracted text is limited to 24,000 characters per file, with any extraction/truncation notice shown before sending. DOCX archives also have expanded-size and entry-count limits. Legacy `.doc`, spreadsheets, audio/video, executables, and arbitrary binary files are unsupported.

Message text is limited to 16,000 characters; bot instructions to 12,000. Responses are capped at 4,096 output tokens and three minutes, with a 45-second idle stream timeout. Provider context windows, account permissions, quotas, and model availability still apply. Very large attachments/context can exceed a smaller local model’s window. No tools or autonomous model actions are enabled.

## Persistence and security

Desktop data: Electron’s per-user `userData/data` directory (on Windows, normally `%APPDATA%/Mukai/data`). Standalone data: `~/.mukai`. Set **`MUKAI_DATA_DIR`** in both terminals to use the same alternative directory for browser development; you can also set it for Electron. Run one backend per data directory.

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
    repositories/             Bot, provider, message, attachment database operations
    services/                 Bot rules, credentials, AI chat, file extraction/storage
    models/                   Internal records and explicit public projections
    http/                     Routes, request validation, auth, NDJSON transport
    config.ts                 Local paths and secrets
    index.ts                  Standalone service lifecycle
  renderer/src/
    app/                      Application composition
    components/               Shared shell and UI components
    services/                 Typed bot/provider/chat/attachment API calls and streaming
    models/                   Renderer chat state and drafts
    features/ai/              Bot UI, chat state coordination, attachment presentation
    features/settings/        Workspace, Appearance, Providers
    features/workspace/       Existing prototype areas
    styles/                   Theme tokens and component styles
```

Server dependencies run from **HTTP → services → repositories → SQLite**. Repositories map SQL rows into typed internal records; services own business rules and project private records into the shared public contracts. HTTP handlers have no SQL, and AI streaming is independent of Node HTTP through a small output interface. `app.ts` constructs the dependencies explicitly.

On the client, components and chat state call typed services rather than building URLs or parsing streams. `services/http.ts` owns authentication and transport errors; `services/chatService.ts` owns the NDJSON reader. Shared request/response types remain in `shared/`, while `renderer/src/models/` contains UI-specific state. ESLint enforces the main import boundaries. The database schema, API paths, UI, and run commands are unchanged by this separation.

## Verification and builds

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
npm run preview
```

Integration tests use the actual AI SDK against a **test-only local OpenAI protocol fixture** and disposable SQLite databases. They cover credentials/redaction, context limits, bot-specific instructions/models, restart persistence, streaming stop/retry, attachments, deletion, and API authentication. Production provider adapters always call the selected real endpoint; no fixture or canned reply is connected to the app.

`npm run build` produces Electron output in `out/` and the standalone service in `dist/server/`. Run the compiled service with `npm run start:server`. `/health` remains public and supports GET/HEAD.

```sh
npm run package     # Unpacked desktop app in release/
npm run dist        # Platform installer
```

Public distribution still needs signing/notarization, updates, and release CI. No cloud sync, user accounts, OCR, autonomous scheduling, Pursuits backend, or advanced bot tools are included.
