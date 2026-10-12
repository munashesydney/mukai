# Mukai CLI

Mukai CLI runs the same backend and React application as Mukai Desktop. The browser UI is bundled with each CLI version and is served locally; the public website is only used to obtain installers and downloads.

## Install

After a complete CLI release is published and the website changes deployed:

```sh
curl -fsSL https://usemukai.com/install | bash
```

Windows PowerShell:

```powershell
irm https://usemukai.com/install.ps1 | iex
```

Supported builds: Windows x64, macOS Intel and Apple Silicon, Linux x64 with glibc. WSL uses the Linux build. Archives include Node 24, production dependencies, the browser UI, and guest/native helper resources. Node, npm, and Electron are not required on the user's machine. Chrome, VM dependencies, and OS permissions for native computer use remain separate prerequisites.

Installers verify SHA-256 checksums before activation. Unix installations live in `~/.local/share/mukai/versions`, with a command in `~/.local/bin`; Windows uses `%LOCALAPPDATA%/MukaiCLI`, registering its `bin` directory in the current user's PATH. No administrator installation is required. Existing unrelated `mukai` commands are not overwritten.

Re-running the installer upgrades or repairs the active CLI through a fresh version directory. Previous installation directories remain available, and a running server finishes using its existing version. An already-running backend must be stopped before launching another against the same data directory. Set `MUKAI_VERSION` to a published version to install that version instead of latest. Set `MUKAI_NO_MODIFY_PATH=1` to install without changing shell profiles or user PATH.

## Commands

```sh
mukai serve --port 8080 --open
mukai serve --port 0
mukai serve --data-dir /path/to/data
mukai status
mukai doctor
mukai auth-reset
mukai --version
mukai --help
```

`serve` runs in the foreground. Ctrl+C stops requests, tools, browser/VM connections, and scheduling, then releases the database lock. The default port is 47831; `PORT` changes it, and `--port` takes precedence. Port 0 selects an available port. `--open` launches your default browser; otherwise open the printed connection link.

On first launch, the terminal prints a private setup code and a setup link. The link puts the code in its fragment, which is removed from the address bar before any requests. Verify the code, then choose your owner username and password. Codes expire after 30 minutes; restart the server to obtain another. Verification gives you five minutes to finish account creation. Once claimed, the installation presents a login page instead of account creation.

Owner credentials and browser sessions persist in SQLite. Passwords use salted scrypt hashes; sessions use random credentials with only their hashes stored. Browser sessions last seven days, survive server restarts, and can be ended with **Sign out** in the title bar. The persistent backend API token stays on the server. Existing private localhost connection links continue working only before owner setup; they cannot bypass an owner login.

The server still exposes a port on `127.0.0.1`. You manage any tunneling or proxying yourself. Served browser requests must be same-origin, and remote login requires HTTPS. A proxy must preserve the browser-facing Host header; Mukai does not trust forwarded headers or manage domains. One owner login controls the entire installation, including its tools; separate users and workspace permissions are not implemented.

For a forgotten username or password, stop the backend and run `mukai auth-reset` with the same data directory. This removes the owner login and revokes browser sessions while preserving workspace data. Restart `mukai serve` to obtain a new setup code. Recovery requires local access to the machine and cannot run while Desktop or the CLI is using the database.

`status` checks a private descriptor, data lock, and authenticated server identity before reporting its connection link. It does not inspect or manage a desktop backend. `doctor` checks the runtime and bundled UI/helpers; it reports the server state. The connection link is private: do not share it or terminal output containing it.

## Data and desktop compatibility

CLI data defaults to the desktop application's existing data directory: `%APPDATA%/mukai/data` on Windows, `~/Library/Application Support/mukai/data` on macOS, and `${XDG_CONFIG_HOME:-~/.config}/mukai/data` on Linux. The lowercase application name is intentional. `MUKAI_DATA_DIR` selects another location, and `--data-dir` takes precedence. Stop Desktop before starting the CLI against the same database. Older CLI data in `~/.mukai` remains untouched; pass that location explicitly to keep using it. There is no automatic database merge or replacement. Database schema checks prevent opening newer data with an older runtime.

Appearance now lives in the existing `app_settings` SQLite table. Open the updated desktop once to import its previous theme and color mode, then stop it before opening the CLI. Initialization never overwrites an already-saved shared appearance. Browser storage is only a startup cache; the shared setting wins across ports, browsers, and desktop launches. Changes save automatically and open clients refresh periodically or when focused. Public base URL and pursuit limits already persist in the database, so selecting the shared data directory also shares those settings.

Core screens, chat, settings, files, and workflows reuse the desktop renderer. Browser mode uses entered server-side folder paths instead of the native folder picker. Native window controls are hidden. The Electron embedded browser remains desktop-only; Chrome tools and VM desktop viewing use their existing backend mechanisms. Native computer-use permission prompts identify the CLI runtime rather than the desktop application on macOS.

## Development and release

```sh
npm run build:cli
npm run cli -- serve --port 8080 --open
npm run package:cli
npm run test:cli:packaged
npm run test:settings-ui
```

CLI code lives in `src/cli`; it delegates to `src/server/app.ts`. Production browser transport lives in `src/server/web`. Build and release scripts live in `scripts/cli`. The staged production dependency installation does not modify the source checkout. Each package is built on its target OS/architecture from the lockfile. `dist/cli` is a build output, not a second source package.

The release workflow builds and smoke-tests desktop and CLI packages, verifies every archive and checksum, and publishes installers, `cli-manifest.json`, and `SHA256SUMS.txt` together through a draft release. The public website advertises CLI only when all expected assets are present; its installer endpoints serve the immutable release scripts maintained in this repository. Publishing and website deployment are separate operational steps.
