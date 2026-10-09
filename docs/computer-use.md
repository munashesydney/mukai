# Computer use

`computer_use` is a built-in tool family in `src/server/tools/computer_use`. Assign it in **Tools**, using the same per-bot controls as browser and terminal. Its actions control the workspace’s chosen computer. A local workspace controls the machine running the API server, including when the UI connects from elsewhere. A QEMU workspace controls its Linux guest; it cannot fall back to the host desktop.

## Actions

| Action                | Fields / behavior                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`              | Backend, permission/dependency readiness; does not inject input.                                                                                                                         |
| `displays`            | Display IDs and desktop bounds. On Wayland, starts a consented sharing session.                                                                                                          |
| `screenshot`          | Optional `displayId`, `maxDimension` (320–3840, default 1920). Saves a PNG artifact and returns `screenshotId`, dimensions and coordinate mapping.                                       |
| `cursor`              | Current desktop position on Windows/macOS/X11. Wayland reports that actual cursor position is unavailable.                                                                               |
| `move` / `click`      | `x`, `y`; optional `screenshotId` or `displayId`. Click accepts `button` and `clicks` (1–2).                                                                                             |
| `drag`                | `x`, `y`, `endX`, `endY`; optional `button`, `durationMs` (default 500).                                                                                                                 |
| `scroll`              | `direction`: up/down/left/right; optional `pixels` (1–5000, default 500), and position. X11/Windows wheel scrolling is approximate; applications determine distance per wheel increment. |
| `type`                | Literal `text`, at most 4000 UTF-16 code units; inserts rather than replacing. Does not use the clipboard.                                                                               |
| `press`               | `key`, e.g. `CTRL+L`, `CMD+L`, `SHIFT+TAB`, `ENTER`, `F5`. CMD maps to Command on macOS and Control elsewhere.                                                                           |
| `key_down` / `key_up` | One named `key`. Holds are owned by the calling conversation and expire after ten seconds.                                                                                               |
| `wait`                | `durationMs`, at most 5000.                                                                                                                                                              |

With `screenshotId`, coordinates are image pixels. The service maps them to the captured display’s desktop coordinates, accounting for resizing and scale. IDs are conversation-scoped, expire after five minutes, and become invalid when monitor geometry changes. Without a capture ID, coordinates are global desktop units; with `displayId`, they are relative to that display’s origin. Negative global coordinates are supported.

Vision models receive PNG pixels. Other models receive saved artifact metadata. Activity summaries omit image bytes. Calls share the normal runtime budget and cancellation signal. One service serializes operations across the local machine; each VM has its own service. Interrupted gestures release injected keys/buttons, and shutdown closes native helpers. Explicit holds are released when another conversation takes control. The tool cannot prevent human input from changing focus during an operation.

## Native backends

- **Windows:** PowerShell hosts a fixed C# Win32 helper, using SendInput, per-monitor DPI awareness, and native screen capture. No Python or third-party automation runtime is required. An unlocked interactive desktop is required. Windows security boundaries can reject input into elevated applications or secure/UAC desktops.
- **macOS 14+:** a compiled Swift helper uses ScreenCaptureKit and CoreGraphics events. Build on macOS with Xcode command-line tools (`npm run build:computer-use`); packaged users do not need development tools. Allow Accessibility and Screen Recording for the helper/Mukai in System Settings → Privacy & Security. The helper is included in the application’s code signing. Named shortcut letters use standard Mac physical key positions; `type` inserts Unicode text independently of keyboard layout. F21–F24 are unavailable on macOS.
- **Linux X11:** Python 3 plus `libX11`, `libXtst`, and `libXrandr`. Run in the graphical user session with the correct `DISPLAY`/`XAUTHORITY`. The VM installer provisions these libraries and deploys the helpers to the existing unprivileged worker. Unicode insertion temporarily uses unused X11 keycodes and restores their mappings; a layout with no spare keycode reports an error.
- **Linux Wayland:** Python GObject bindings, GStreamer/PipeWire, and a compositor implementing both RemoteDesktop and ScreenCast portals. Desktop sharing/control requires the system consent dialog. No XWayland fallback is used because it cannot control native Wayland applications. The helper uses the supported D-Bus Notify input methods and captures the consented PipeWire streams. Global cursor queries are unavailable; only the last tool-requested position is reported. Unsupported compositors and missing plugins report setup errors.

Ubuntu/Debian X11 dependencies:

```sh
sudo apt-get install python3 libx11-6 libxtst6 libxrandr2
```

Additional Wayland dependencies (use the portal backend matching your desktop, e.g. GNOME or KDE):

```sh
sudo apt-get install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good xdg-desktop-portal
```

VM guest revision 8 deploys this tool through the existing upgrade mechanism while preserving workspace disks.

## Validation

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:computer-use` for a read-only native status/display/screenshot check. `npm run test:computer-use -- --interactive` opens a disposable Electron window and verifies real mouse/keyboard input, Unicode typing, shortcuts, scrolling, and drag gestures. The interactive check temporarily focuses that test window. `npm run test:computer-use:vm -- --data-dir PATH` boots a disposable copy of that installation’s prepared Linux base, applies the current guest bundle and verifies actual X11 events through the VM protocol; personal workspace disks are never opened. Run `npm run build:guest` first. This requires a prepared VM installation and may install missing dependencies inside the disposable copy. VM routing is also tested through the guest dispatcher and tool assembly tests. Cross-platform CI builds helpers and runs the X11 test in a virtual desktop; macOS permission-gated capture and Wayland consent require a graphical session.
