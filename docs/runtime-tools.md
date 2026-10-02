# Browser, terminal and process tools

All bots use the existing chat tool loop, including space responses and scheduled pursuit runs.
Runtime ownership includes workspace, bot and conversation. AI tools cannot control another
conversation's tabs or processes. The authenticated desktop UI can browse its workspace tabs.

## Browser

`browser` supports `open`, `tabs`, `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`,
`back`, `forward`, `reload`, `screenshot` and `close`.

- `target: "mukai"` embeds a sandboxed Electron WebContentsView in the right browser panel.
- `target: "chrome"` launches installed Google Chrome in a separate visible window using
  Playwright Core and a dedicated profile. No browser download is needed.
- Profiles are isolated per workspace, bot and conversation. They retain website logins;
  live tab IDs last only until the application closes.
- The model takes a snapshot before interacting. References are generated in an isolated
  JavaScript world, include open shadow roots, and expire on another snapshot or navigation.
- Screenshots are sent as images when the selected model supports vision; other models get
  the screenshot location and use text snapshots. Snapshots mask password field values.
- This first version controls the main document and open shadow roots. Cross-origin iframe
  controls, file uploads, popups, downloads and permission prompts are not supported.
- Remote pages receive no Mukai preload, Node integration or API token. Browser protocol
  commands have a timeout. The renderer can only place the active embedded view within the
  app's content bounds; dialogs hide it so it cannot cover their controls.

Example: ask a bot to open a website in the Mukai browser, or explicitly ask it to use Chrome.
The browser panel opens when a tab is created. Hiding the panel keeps the tab alive; closing
the tab destroys it. Reopen it with the panel icon in the conversation header. Drag its left
divider to resize; arrow keys also resize the focused divider and a double-click resets its
width. The width is retained locally and clamped when the window shrinks. The native page is
hidden during dragging so it cannot steal pointer events. Chrome must be installed separately.

## Response limits and recovery

The shared chat runner permits 64 model tool steps and reserves a final, tool-free report.
Per-response budgets allow 128 browser/terminal/process calls and 64 file operations, including
parallel calls within a step. The existing three-minute total response timeout still applies;
this is not yet an hour-long background job runner.

If the provider emits DeepSeek DSML invocation markup as ordinary answer text, the runner
attempts one continuation with the genuine SDK tool calls/results retained. It never parses
that text into executable calls. Recovery shares the original time and call budgets. A second
malformed answer is saved as failed with an actionable error rather than marked complete.
Diagnostics log only step count and finish reason, not prompts, tool arguments or credentials.

## Terminal and processes

`terminal` runs PowerShell on Windows and `/bin/sh` on other platforms, without a PTY.
Each command starts a fresh shell in the workspace folder or an explicitly selected
subdirectory. This is a local shell with OS account permissions, not a filesystem sandbox.
Credential-like environment variables are removed from the inherited environment, but this
does not prevent a shell command from accessing files permitted to the OS account.

Commands that finish within `yieldMs` return output and an exit code. Longer commands return
a live session ID; `background: true` returns immediately. Use `process` to `list`, `poll`,
`wait`, read `log` from an offset, `write` stdin, or `kill` the owned process tree.

Output retention is limited to 64,000 characters per process, with absolute offsets and a
truncation flag. Running sessions have a lifetime limit, and all managed processes are stopped
on backend shutdown. Sessions and logs do not survive restart. Shell writes do not generate
file-change snapshots; use `file_operations` for recorded diffs and artifacts.

## Verification

`npm test` covers process execution, output bounds, ownership, background input, cancellation,
lifetime limits, browser ownership, protocol validation and the actual SDK tool loop.

`npm run test:browser` requires a desktop build (`npm run build`), Electron and installed Google Chrome. It launches a temporary
test window and Chrome profile against a loopback fixture, checks navigation, typed input,
mouse and keyboard events, stale references, password masking, screenshots and tab cleanup.
It also loads the production renderer and checks dragging over a native browser view, keyboard
resizing, view placement, header hide/reopen and width persistence after reload,
then removes its disposable profile. It never uses real provider credentials or user chats.
