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

Supported builds: Windows x64, macOS Intel and Apple Silicon, Linux x64 with glibc. WSL uses the Linux build. Archives include Node 24, production dependencies, the browser UI, and guest/native helper resources. Node, npm, and Electron are not required on the user's machine. Chrome and OS permissions for native computer use remain separate prerequisites.

On Ubuntu/Debian, the shell installer installs missing QEMU VM dependencies (`qemu-system-x86` and `qemu-utils`) after verifying the downloaded release. Run the install command as your normal user: only system setup commands use `sudo`, with password approval through your terminal, including over SSH. Do not pipe the installer into `sudo bash`; Mukai belongs in your user's home directory. Without an interactive terminal, installation requires existing sudo authorization or passwordless sudo. Set `MUKAI_SKIP_VM_DEPS=1` on `bash` to skip this step, for example `curl -fsSL https://usemukai.com/install | MUKAI_SKIP_VM_DEPS=1 bash`. Other Linux distributions require manually installing QEMU, and macOS/Windows install it during VM setup.

The Linux installer also checks `/dev/kvm` access, including when QEMU is already installed. When the device belongs to the `kvm` group, it can request sudo approval to append your OS user to that group. Log out and back in before starting Mukai to activate the membership. Missing hardware acceleration or denied permission approval does not prevent installing Mukai: VM setup tests software emulation as a fallback and displays its performance warning.

Installers verify SHA-256 checksums before activation. Unix installations live in `~/.local/share/mukai/versions`, with a command in `~/.local/bin`; Windows uses `%LOCALAPPDATA%/MukaiCLI`, registering its `bin` directory in the current user's PATH. Mukai's user files do not require administrator installation; system dependencies and KVM membership may require approval. Existing unrelated `mukai` commands are not overwritten.

Run `mukai update` to download and activate the latest CLI release. Updates verify the release's SHA-256 checksum, platform, version, and bundled Node runtime before switching the launcher atomically. Previous installation directories remain available, and a running server finishes using its existing version. Stop and start that server to use a terminal-installed update. A newer client reports a version mismatch until the backend is restarted on the matching version.

Re-running the installer also upgrades or repairs the active CLI through a fresh version directory. Set `MUKAI_VERSION` to a published version to install that version instead of latest. Set `MUKAI_NO_MODIFY_PATH=1` to install without changing shell profiles or user PATH.

## Commands

```sh
mukai serve --port 8080 --open
mukai serve --port 0
mukai serve --data-dir /path/to/data
mukai status
mukai doctor
mukai auth-reset
mukai update
mukai --version
mukai --help
```

`serve` starts a foreground backend or reuses the running backend for its selected data directory. Reuse prints the existing connection address and exits without taking shutdown ownership. A different requested port does not start another backend for the same directory. For a newly started backend, Ctrl+C stops requests, tools, browser/VM connections, and scheduling, then releases the data lock. The default port is 47831; `PORT` changes it, and `--port` takes precedence. Port 0 selects an available port. `--open` launches your default browser with the new or existing connection link.

In installer-managed CLI releases, **Settings → Updates** supports manual checks, download progress, and the persisted automatic-update preference. Background checks run after 15 seconds and every four hours when enabled. Downloads wait for **Restart to update**; a confirmation explains that running bots and tools will stop. A foreground supervisor shuts down the old backend, releases its data lock, and starts the new bundled runtime with the same data directory and bound port (including `--port 0`). The browser reconnects and reloads the bundled UI. Ctrl+C still stops the replacement server. Logged-in owner sessions persist across this restart; an unclaimed installation requires its new terminal setup code. Terminal updates do not interrupt running servers.

Source checkouts and manually unpacked portable archives show updates as unavailable; use the installer to obtain a managed installation. Desktop continues to use its native updater. CLI updates do not change PATH, install system dependencies, or write to application data.

On first launch, the terminal prints a private setup code and a setup link. The link puts the code in its fragment, which is removed from the address bar before any requests. Verify the code, then choose your owner username and password. Codes expire after 30 minutes; restart the server to obtain another. Verification gives you five minutes to finish account creation. Once claimed, the installation presents a login page instead of account creation.

Owner credentials and browser sessions persist in SQLite. Passwords use salted scrypt hashes; sessions use random credentials with only their hashes stored. Browser sessions last seven days, survive server restarts, and can be ended with **Sign out** in the title bar. The persistent backend API token stays on the server. Existing private localhost connection links continue working only before owner setup; they cannot bypass an owner login.

The server still exposes a port on `127.0.0.1`. You manage any tunneling or proxying yourself. Served browser requests must be same-origin, and remote login requires HTTPS. A proxy must preserve the browser-facing Host header; Mukai does not trust forwarded headers or manage domains. One owner login controls the entire installation, including its tools; separate users and workspace permissions are not implemented.

For a forgotten username or password, stop the backend and run `mukai auth-reset` with the same data directory. This removes the owner login and revokes browser sessions while preserving workspace data. Restart `mukai serve` to obtain a new setup code. Recovery requires local access to the machine and cannot run while Desktop or the CLI is using the database.

`status` checks a private descriptor, data lock, and authenticated server identity before reporting its connection link, whether the backend was started by desktop or CLI. `doctor` checks the runtime and bundled UI/helpers; it reports the server state. The connection link is private: do not share it or terminal output containing it.

## Data and desktop compatibility

CLI data defaults to the desktop application's existing data directory: `%APPDATA%/mukai/data` on Windows, `~/Library/Application Support/mukai/data` on macOS, and `${XDG_CONFIG_HOME:-~/.config}/mukai/data` on Linux. The lowercase application name is intentional. `MUKAI_DATA_DIR` selects another location, and `--data-dir` takes precedence. Desktop and `serve` share one backend per directory, verified by its PID lock, local API token, instance ID, and version. A separate OS lease protects concurrent startup and stale-lock recovery. Desktop discovers the actual port, including `--port 0`, and never selects a different directory just because it occupies port 47831. Versions must match before attaching. Older CLI data in `~/.mukai` remains untouched; pass that location explicitly to keep using it. There is no automatic database merge or replacement. Database schema checks prevent opening newer data with an older runtime.

Closing a desktop window hides it and keeps its backend and embedded browser alive. The Mukai tray menu reopens the window, opens the web interface, or explicitly quits Mukai. Quitting an attached desktop leaves its CLI backend running. Explicitly quitting a desktop-owned backend or pressing Ctrl+C in the owning CLI terminal disconnects all of that backend's clients.

Appearance lives in the existing `app_settings` SQLite table. Open the updated desktop once to import its previous theme and color mode. Initialization never overwrites an already-saved shared appearance. Browser storage is only a startup cache; the shared setting wins across ports, browsers, and desktop launches. Changes save automatically and open clients refresh periodically or when focused. Public base URL and pursuit limits also persist in the database, so selecting the shared data directory shares those settings.

Core screens, chat, settings, files, and workflows reuse the desktop renderer. Browser mode uses entered server-side folder paths instead of the native folder picker. Native window controls are hidden. Browser capabilities follow the backend host: a desktop-owned backend supports the embedded Mukai browser, while a CLI-owned backend uses Chrome even when a desktop UI connects. Opening another interface does not move running browser sessions. VM desktop viewing remains available to both interfaces. Native computer-use permission prompts identify the owning runtime on macOS.

## Development and release

```sh
npm run build:cli
npm run cli -- serve --port 8080 --open
npm run package:cli
npm run test:cli:packaged
npm run test:cli:updates
npm run test:settings-ui
npm run test:shared-backend
```

CLI code lives in `src/cli`; it delegates to `src/server/app.ts`. Production browser transport lives in `src/server/web`. Build and release scripts live in `scripts/cli`. The staged production dependency installation does not modify the source checkout. Each package is built on its target OS/architecture from the lockfile. `dist/cli` is a build output, not a second source package.

The release workflow builds and smoke-tests desktop and CLI packages, verifies every archive and checksum, and publishes installers, `cli-manifest.json`, and `SHA256SUMS.txt` together through a draft release. The public website advertises CLI only when all expected assets are present; its installer endpoints serve the immutable release scripts maintained in this repository. Publishing and website deployment are separate operational steps.
