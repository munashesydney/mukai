# Shared desktop and CLI backend

## Contract

- Discover backends by the selected data directory, never by scanning ports.
- Keep the existing PID lock and add a separate SQLite OS lease so crash recovery is exclusive even when launchers race. Repeated `serve` invocations reuse the verified backend and report its actual port, including when `--port 0` was used.
- Publish the PID, instance ID, version, and browser address atomically after startup. Verify the data lock, local token, and HTTP instance identity before attaching.
- Wait for a competing startup to publish its identity. Reject incompatible versions and unverified live locks with an actionable error.
- Desktop connects to the backend for `MUKAI_DATA_DIR` or its usual default directory. When starting a backend, use an available port if another directory occupies the default port.
- Desktop-owned backends serve the browser UI too. Preserve native token authentication, browser owner login, and single-use VM viewer tickets.
- Closing a desktop window hides it and keeps its backend and embedded browser alive. A tray menu reopens Mukai or explicitly quits it. Quitting an attached desktop never stops somebody else's backend. Ctrl+C explicitly stops a CLI-owned backend; a reused `serve` exits without taking ownership.
- Preserve the backend host's browser capabilities: an Electron-owned backend supports the embedded browser; a CLI-owned backend uses Chrome. Opening another interface does not migrate running tools.

## Implementation

1. Share backend identity publication and verified discovery between hosts; add a start-or-connect coordinator and startup race handling.
2. Make `serve` reuse a running backend before checking local UI assets or starting update workers.
3. Make desktop attach or start, serve packaged web assets, preserve native HTTP/WebSocket access, and separate attached-client shutdown from backend shutdown.
4. Add tray lifecycle controls, documentation, integration tests for separate directories, ephemeral ports, authentication, startup races, and shutdown ownership.

## Validation

Run focused backend/CLI/auth/VM transport tests, type checking, lint, production builds, and a desktop + CLI integration smoke test covering both launch orders and window close/reopen.

Completed on macOS: the full suite passed (1,360 tests, 4 skipped), type checking and lint passed, desktop and CLI production builds passed, and `npm run test:shared-backend` passed with both launch orders, separate ephemeral backends, native/browser authentication, shared update preferences, and close/reopen/shutdown ownership. The lock tests also exercise competing processes reclaiming a stale lock and recovery after a forced process exit.

An independent OS service, login startup, and live migration between Chrome and Electron browser hosts are outside this change. Explicitly stopping the owning backend disconnects its clients.
