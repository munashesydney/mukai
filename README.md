# Mukai

**Wake up to what’s possible.** Mukai means “wake up” in Shona. An Electron workspace for your spaces, pursuits, and bots, built with React and TypeScript.

This first version is a working UI prototype with a real local Node health service. Atlas, Nova, and Scout are sample personalities; they do not call AI models or run background work.

## Get started

Requires Node.js 22.12+ (Node 24 LTS recommended) and npm.

```sh
npm ci
npm run dev
```

`npm run dev` launches Electron, the React development server, and the local API. The desktop service binds to a random available loopback port and shuts down with the app. Check its connection under **Settings → Node service**.

For browser development, run these in separate terminals:

```sh
npm run dev:web
npm run dev:server
```

Open http://127.0.0.1:5173. The Vite proxy maps `/api/health` to the standalone server at http://127.0.0.1:4318/health. Set `PORT` in your shell to choose another standalone API port; update the Vite proxy target to match. `.env.example` documents the default; the server reads process environment variables rather than loading `.env` files.

## What works

- Bots, Pursuits, Spaces, and Tools navigation, with back/forward history.
- Spaces and individual bot conversations.
- Opens directly into a bot conversation. Details panels stay closed until requested; Files and Activity are secondary views.
- Local message composition, Enter/Shift+Enter, emoji insertion, reactions, and saved messages.
- Search for spaces, bots, and pursuits (`Ctrl+K` / `Cmd+K`).
- Create spaces and pursuits; pause and resume pursuits.
- Files and activity views, a draft preview, and contextual bot, pursuit, and space details.
- Integration previews with explicit demo states.
- Native minimize, maximize/restore, close, and draggable title bar.
- Workspace and Appearance settings, with six color palettes and Light/Dark/System modes.

Workspace messages, spaces, pursuits, bookmarks, and reactions persist in versioned local storage. There is no cloud sync. Attachments show filenames only; file contents are neither saved nor uploaded. Integration selection is session-only. Custom bots and customization currently show preview information.

Appearance preferences are stored separately under `mukai.appearance.v1`. Themes apply immediately across the shell, conversations, forms, and dialogs; System mode follows device appearance changes. The default remains Mukai in light mode.

## Structure

```text
src/
  main/                       Electron lifecycle, windows, IPC
  preload/                    Narrow, typed desktop bridge
  server/                     Node HTTP service and endpoint tests
  shared/                     Renderer/main/service contracts
  renderer/
    public/                   Brand assets
    src/
      app/                    Application composition
      components/
        layout/               Title bar, rail, workspace sidebar
        ui/                   Avatar, brand, modal, buttons, error boundary
      features/
        appearance/           Theme palettes, preferences, and provider
        chat/                 Conversation, messages, cards, composer
        settings/             Workspace and Appearance settings panels
        workspace/            Demo data, state, dialogs, search, integrations
      styles/                 Design tokens and responsive styles
```

The renderer has no Node access. Electron uses context isolation, a sandboxed preload, restricted IPC, denied permissions, blocked navigation and new windows, and a Content Security Policy. Fonts are bundled for offline use. The API binds only to `127.0.0.1`; there are no remote calls from the UI.

## Health endpoint

```sh
curl http://127.0.0.1:4318/health
```

```json
{
  "status": "ok",
  "service": "mukai-api",
  "version": "0.1.0",
  "uptime": 42,
  "timestamp": "2026-10-01T12:00:00.000Z"
}
```

Supports GET and HEAD; unsupported methods return 405 and unknown routes return 404. The desktop renderer reads health through IPC rather than receiving the service address or unrestricted network capabilities.

## Checks and builds

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
npm run preview
```

`npm run build` outputs Electron artifacts to `out/` and a standalone Node service to `dist/server/`. `npm run start:server` runs the compiled standalone service. `npm run build:web` produces an optional browser build in `dist/web/`; browser health checks need a host with the same `/api` proxy.

```sh
npm run package     # Unpacked desktop app in release/
npm run dist        # Platform installer: NSIS, DMG, or AppImage
```

Installer configuration and the Mukai logo are included. Public distribution still needs signing/notarization, an update strategy, and release CI. Authentication, AI behavior, real integrations, durable server storage, and encrypted secrets are future work.
