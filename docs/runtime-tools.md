# Browser, terminal and process tools

All bots use the existing chat tool loop, including space responses and scheduled pursuit runs.
Runtime ownership includes workspace, bot and conversation. AI tools cannot control another
conversation's tabs or processes. The authenticated desktop UI can browse its workspace tabs.

## Web search and page content

`web_search` is one built-in tool family with `search` and `fetch` actions, enabled by default
for all bots. It works without a workspace folder or provider credentials. Tool assignments
can disable it; children created by a bot inherit its permitted tools.

- `search` accepts `query` or `queries` (not both), with up to three queries. `maxResults`
  defaults to five per query and is capped at ten. Optional `includeDomains`, `excludeDomains`,
  `startDate` and `endDate` restrict sites and publication dates.
- `fetch` accepts `urls`, with up to five public HTTP(S) URLs. It retrieves readable page
  content, without opening a browser or using browser logins.
- `maxCharacters` bounds each source's text: 2,000 by default for search, 8,000 for fetch,
  and a maximum of 20,000. Sources include title, URL, text, a truncation flag, and publication
  date when provided. Content at the extraction limit is conservatively marked truncated.
- Batches return `items` with per-item success/error information; `partial` means at least
  one item failed. Completed items remain available when another item fails. Each query or URL
  consumes one runtime operation, and the entire batch budget is reserved before starting.

Exa's hosted MCP server is tried first. On confirmed rate limiting, the same operation uses
Tavily's keyless search/extract endpoints. The model never selects a provider. Empty results,
ordinary provider failures and user cancellation do not trigger fallback. Provider cooldowns
are shared across bots within the server instance and honor retry/reset timing; when absent,
a one-minute cooldown is used. No account credentials or browser cookies are sent. Tavily uses
one opaque session ID per server process, and requests use a Mukai client identifier.

Provider responses are limited to 2 MiB, requests to 20 seconds per provider attempt, and
batches to 90 seconds. At most two items run across concurrent chats, and Exa requests are
paced. Chat cancellation stops queued waits and network requests. Anonymous allowances are
finite and can be shared by public IP; if both providers are throttled, the tool reports retry
timing instead of repeatedly sending requests. Cooldowns reset on server restart.

Use `browser` for interactions and signed-in pages. Search excerpts and fetched content are
untrusted data; bots are instructed to ignore embedded instructions and cite returned URLs.
Tests use local/mocked provider fixtures rather than spending anonymous provider quota.

## Local images

`image` is a built-in family with `read` and `view` actions, enabled by default and
controlled by bot tool assignments. It works even without a workspace folder.

- `path` accepts an absolute local path, including outside the workspace. Relative
  paths resolve against the workspace folder; without a folder, use an absolute path.
  Files refer to the computer running Mukai's server and its OS account permissions.
- `read` validates and decodes the file and returns its path, format, dimensions and
  byte size. It returns metadata only, not a visual observation.
- `view` reads the file and sends actual image content to the configured vision model
  in the same call. Text-only models receive an error directing them to a vision model.
- PNG, JPEG and still WebP are supported. Inputs are limited to 10 MiB and 40 million
  pixels. Images are normalized to PNG with metadata stripped and orientation applied.
  `detail: "high"` (default) scales the longest edge to at most 2048 pixels;
  `detail: "original"` preserves resolution. Normalized outputs are limited to 10 MiB.
- Full access runs permitted calls immediately. Ask for approval waits for approval of
  the exact invocation before opening the file, including paths outside the workspace.
  Rejected calls never read or decode the image. Existing approval restart recovery applies.
- Image bytes are omitted from activity logs. The existing model context policy may
  omit images that exceed the available allowance and returns an explicit notice.
  Bots must not claim to have inspected metadata-only, failed or omitted results.

Example: `{"action":"view","path":"C:\\Users\\sydne\\Downloads\\picture.png"}`.

## Browser

`browser` supports `open`, `profiles`, `tabs`, `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`,
`back`, `forward`, `reload`, `screenshot` and `close`.

`npm run test:browser-profiles` checks real Chrome/Electron profile sharing, separate
conversation windows, workspace isolation, and login persistence using disposable profiles.
It also checks main Chrome attachment against a disposable profile with an existing login
cookie, named profile selection with separate cookies/windows, rejecting an intentionally
misrouted profile window, preserving personal tabs and reconnecting. Endpoint discovery and native consent
are substituted for this automated check; Chrome's approval dialog needs manual testing.

- `target: "mukai"` embeds a sandboxed Electron WebContentsView in the right browser panel.
- `target: "chrome"` launches installed Google Chrome in a separate visible window using
  Playwright Core and a dedicated profile. No browser download is needed.
- `target: "chrome-default"` connects to the running main Chrome on the workspace's computer,
  using its existing logins and site data. It creates conversation windows and only controls
  tool-created tabs; personal tabs stay open when bot tabs or Mukai close. This profile is
  shared with the user and any other local workspaces choosing main Chrome.
- Each workspace has one persistent Chrome profile and a separate persistent inline
  Electron profile. Bots and conversations share logins within each browser target;
  inline and Chrome logins remain independent. Other workspaces have separate profiles.
- Chrome conversations open in separate native windows. Additional opens in a conversation
  become tabs in its window. Selecting another main Chrome profile creates a separate window
  for that conversation/profile pair. Tab control remains scoped to the creating bot and conversation.
  Profiles retain website logins; live tab IDs last only until the application closes.
- Existing conversation-scoped profiles are kept on disk, without automatically merging
  accounts. Sign in once in the new workspace profile, or choose main Chrome for existing logins.
- The model takes a snapshot before interacting. References are generated in an isolated
  JavaScript world, include open shadow roots, and expire on another snapshot or navigation.
- Every bot screenshot is saved as a unique PNG artifact in
  `<workspace>/.mukai/artifacts/screenshots/<artifact-id>.png`. Without a workspace
  folder, screenshots use `<Mukai data>/artifacts/screenshots/<workspace-id>/`.
  Tool results include `artifactId`, absolute `path`, `width`, and `height`.
  Captures appear in that conversation's Artifacts view with a thumbnail, full image
  preview, and download. Files and previews survive closing the tab and restarting
  Mukai; subsequent captures never overwrite earlier ones. Storage is limited to
  16 MiB per PNG. The temporary browser screenshot endpoint remains available.
- Screenshots are sent as images when the selected model supports vision. Delivery
  fields `imageIncluded` and `imageDelivery` distinguish `included`, `omitted` by
  context limits, and `unsupported` for text-only models. The activity log hides image
  bytes and shows the same delivery status. Saved files remain available even when
  model context omits the pixels; use `image view` with the returned absolute path to
  inspect them again. This follows the existing tool approval policy. Saving and
  artifact registration happen only after the screenshot invocation is approved.
  Snapshots mask password field values.
- This first version controls the main document and open shadow roots. Cross-origin iframe
  controls, file uploads, popups and permission prompts are not supported. Dedicated profiles
  disable downloads; main Chrome retains the user's download settings, without a download tool API.
- Remote pages receive no Mukai preload, Node integration or API token. Browser protocol
  commands have a timeout. The renderer can only place the active embedded view within the
  app's content bounds; dialogs hide it so it cannot cover their controls.

To use main Chrome, open Chrome 144 or newer on the workspace's computer, enable remote
debugging at `chrome://inspect/#remote-debugging`, and allow Chrome's native connection
request when the bot opens `target: "chrome-default"`. For VM workspaces this setup happens
inside the guest. In the VM, `mukai` aliases `chrome`; `chrome-default` uses the guest's main
Chrome, never the laptop's. Failed or denied connections return setup instructions and never
switch profiles. Main mode opens fresh tool-owned tabs sharing cookies and persistent site
data; state confined to an existing tab (such as sessionStorage) is not copied. See
[Chrome's connection documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect).

For named profiles such as Personal and Work, first call `browser` with `{"action":"profiles"}`.
It reads Chrome's profile metadata on the workspace's computer and returns existing profile
IDs, display names, and a last-used hint without connecting to Chrome or reading cookies.
Then open with `{"action":"open","target":"chrome-default","profileId":"Profile 1","url":"https://example.com"}`,
using an ID from discovery. The returned `tab.profile` identifies the verified actual profile.
Without `profileId`, further opens continue the conversation's most recently used profile;
a new conversation uses Chrome's current profile. A tab's profile stays fixed once opened.

Selected profile windows are opened through Chrome's normal launcher, using a temporary
loopback page to identify the new tab. Mukai verifies its profile path before visiting the
requested site. No cookie copying, profile merging, or debugging preference changes occur.
Unknown profiles and mismatches fail without using another profile. Create, rename, unlock,
or finish setting up profiles in Chrome itself, then retry discovery. Only stable Google
Chrome's standard user data directory is supported, on Windows, macOS, and Linux.

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
