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
mukai --version
mukai --help
```

`serve` runs in the foreground. Ctrl+C stops requests, tools, browser/VM connections, and scheduling, then releases the database lock. The default port is 47831; `PORT` changes it, and `--port` takes precedence. Port 0 selects an available port. `--open` launches your default browser; otherwise open the printed connection link.

The connection link carries a per-server bootstrap credential in its fragment (not an HTTP query). The UI removes it from the address bar, exchanges it for an HttpOnly SameSite=Strict cookie, and mounts the existing application. The persistent API token stays on the server. Sessions last up to 24 hours and are invalidated by a server restart. Reopen the connection link from `mukai status` to renew an expired session without stopping ongoing work. The server binds to 127.0.0.1 and supports local browser access; this is not a multi-user/network hosting mode.

`status` checks a private descriptor, data lock, and authenticated server identity before reporting its connection link. It does not inspect or manage a desktop backend. `doctor` checks the runtime and bundled UI/helpers; it reports the server state. The connection link is private: do not share it or terminal output containing it.

## Data and desktop compatibility

Standalone data defaults to `~/.mukai`, or `MUKAI_DATA_DIR`. `--data-dir` takes precedence. Desktop retains its existing per-user Electron data directory. To use that data in browser mode, stop Desktop and pass its data directory explicitly. There is no automatic copying or migration between locations, and both modes enforce one backend per data directory. Database schema checks prevent opening newer data with an older runtime.

Core screens, chat, settings, files, and workflows reuse the desktop renderer. Browser mode uses entered server-side folder paths instead of the native folder picker. Native window controls are hidden. The Electron embedded browser remains desktop-only; Chrome tools and VM desktop viewing use their existing backend mechanisms. Native computer-use permission prompts identify the CLI runtime rather than the desktop application on macOS.

## Development and release

```sh
npm run build:cli
npm run cli -- serve --port 8080 --open
npm run package:cli
npm run test:cli:packaged
```

CLI code lives in `src/cli`; it delegates to `src/server/app.ts`. Production browser transport lives in `src/server/web`. Build and release scripts live in `scripts/cli`. The staged production dependency installation does not modify the source checkout. Each package is built on its target OS/architecture from the lockfile. `dist/cli` is a build output, not a second source package.

The release workflow builds and smoke-tests desktop and CLI packages, verifies every archive and checksum, and publishes installers, `cli-manifest.json`, and `SHA256SUMS.txt` together through a draft release. The public website advertises CLI only when all expected assets are present; its installer endpoints serve the immutable release scripts maintained in this repository. Publishing and website deployment are separate operational steps.
