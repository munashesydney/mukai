# QEMU workspace v1

Workspace creation offers **Local machine** or **Linux VM (preview)**. Existing workspaces stay local. A workspace's computer type is fixed when created. All bots in a VM workspace share one persistent guest disk; their process/browser sessions retain bot and conversation ownership checks.

## Supported in this version

- Terminal, background processes, bounded logs, stdin, wait and termination inside Linux.
- Workspace file operations with change history and downloadable text artifacts.
- Guest image metadata and vision input, including absolute guest paths.
- Visible guest Chrome snapshots, interactions and screenshots saved as Mukai artifacts.
- Live Linux desktop with mouse/keyboard control, watch mode and automatic display resizing. **View computer** hides navigation and keeps chat at 25% beside the 75% desktop; **Back to workspace** restores the normal layout without stopping the VM.
- Automatic startup on first computer tool call; manual start/stop/status in Settings → Workspace; shutdown when Mukai closes.
- Host-side chats, model connections, permissions, bots, memory, skills, web search and pursuits.

Custom tools/routes are unavailable in VM v1, including through management APIs. They never fall back to host Node. There are no host folder mounts, application preview port forwarding, snapshots, or automatic orphan recovery yet. Uploads are model attachments; there is no guest upload/import UI yet. Local mode retains its existing behavior.

## Automatic setup

Choose **Linux VM** in the workspace creation dialog. Mukai installs missing QEMU, checks hardware acceleration, downloads the official Ubuntu 24.04 cloud image matching the host CPU over HTTPS, verifies its SHA-256, and prepares Node.js 24, a browser, Xfce and TigerVNC with the guest tools inside a disposable VM. x64 guests use Google Chrome; Apple Silicon guests use Playwright's pinned native ARM64 Chromium build. A second boot verifies the guest bridge, CPU architecture and installed tools before publishing the base image. The dialog shows progress and enables workspace creation when setup succeeds. Setup continues if the dialog is closed.

Windows uses Winget's `SoftwareFreedomConservancy.QEMU` package and can enable Windows Hypervisor Platform with administrator approval. If Windows requires a reboot, Mukai reports it and resumes when reopened; it never reboots the computer itself. Firmware virtualization must already be enabled. macOS uses an existing Homebrew installation; Ubuntu/Debian uses apt-get with pkexec for administrator approval. Other Linux distributions require manually installing QEMU first. Automatic setup supports x64 hosts and Apple Silicon Macs, and requires at least 12 GiB free on Mukai's data drive. ARM Windows/Linux hosts are not supported. Allow several minutes, internet access and any OS administrator prompts.

On Apple Silicon, Mukai selects `qemu-system-aarch64`, the ARM64 Ubuntu image, the `virt` machine, and macOS HVF acceleration with the host CPU. QEMU's bundled `edk2-aarch64-code.fd` supplies UEFI; it is discovered relative to the QEMU installation or in standard Homebrew locations. Firmware is read-only and boot uses the image's EFI fallback loader, so it does not need a shared writable EFI variables disk. `MUKAI_QEMU_FIRMWARE` optionally supplies an absolute firmware path. Setup uses the ARM UART (`ttyAMA0`) for progress output. Chromium is installed inside the guest without Snap and has a path-specific AppArmor policy for its sandbox. Its desktop launcher and browser tools share the existing guest main-profile location (`~/.config/google-chrome`); browser target names stay the same.

Ordinary app startup detects existing setup without installing software for local workspaces. Once VM setup has been requested, unfinished setup resumes on app startup, including after a required Windows restart. Failed setup offers Retry. Retries may download the image again; partial downloads are never used as a base image. Setup files live under `computer-setup/` in Mukai's data directory. Each workspace gets a separate full copy of the prepared 32 GiB virtual disk, so allow additional physical storage as its files grow.

The modal shows activity throughout installation and provisioning, download counts when available, and expandable setup output. A bounded `computer-setup/setup.log` records each attempt; failure details remain available after reopening Mukai. The virtualization check uses a QMP control socket, avoiding Windows QEMU's unreliable piped console input.

Desktop builds include the guest bundle as an application resource. `npm run dev`, `npm run dev:server` and `npm run build` generate it automatically. Environment overrides below remain available for an operator-prepared image.

## Optional manual base image

You can supply a standalone **qcow2 image matching the host CPU** instead of automatic preparation: x86_64 with BIOS boot on x64, or aarch64 with UEFI boot on Apple Silicon. A normal Ubuntu/Debian installation with systemd works. The ARM image must include the standard EFI fallback loader. Do not use an overlay that depends on another image; every workspace receives a full copy of the base. Allocate enough disk space for the base plus a full copy per workspace. Prepared disks cannot move between CPU architectures.

1. Install QEMU on the host. On Windows, enable Windows Hypervisor Platform and reboot if required. Hardware acceleration uses WHPX on Windows, KVM on x64 Linux, or HVF on macOS. Apple Silicon needs `qemu-system-aarch64` and ARM UEFI firmware (both supplied by Homebrew's QEMU). `MUKAI_QEMU_ACCEL=tcg` enables slower software emulation for development; it still uses a guest matching the host architecture.
2. In this repository run `npm run build:guest`. This produces `dist/guest/` with the bundled daemon, pinned direct dependency versions, installer and systemd unit.
3. Boot a disposable Ubuntu/Debian guest and copy the contents of `dist/guest/` into it, using SSH/SCP or an ISO. Inside the guest, from that directory, run `sudo sh install.sh`. The installer downloads native Node 24 (checks its SHA-256), Chrome or ARM64 Chromium and required packages, creates the guest account, and enables the daemon. The ARM installer targets Ubuntu 24.04, including its AppArmor policy format. It must run inside QEMU/KVM. The guest account has passwordless sudo **inside this guest** for development work.
4. Shut the guest down cleanly. Use `qemu-img convert -O qcow2 source-disk prepared-mukai.qcow2` if needed to flatten the image. Keep the prepared base offline and unchanged while Mukai uses it. The image must boot without an installer/seed ISO. The guest service activates when Mukai supplies its virtio serial device.

The service does not need a network listener or SSH once prepared. Mukai passes a new identity through QEMU `fw_cfg` on every boot and communicates over a dedicated virtio serial channel. A root-owned supervisor holds the boot identity and serial channel; bot tools run in a separate `mukai` worker without those credentials or inherited root groups. The account retains passwordless sudo for package installation and administration inside its VM.

Ordinary `shutdown`, `poweroff`, `reboot`, `halt` and systemctl power operations are blocked. Attempts to stop, restart, disable or mask the guest bridge through systemctl are also blocked; inspecting it and managing other services remain available. These are accidental-disruption guardrails: full root access can deliberately bypass or remove them. Mukai's host controller still controls VM start/stop through QEMU. There is no bot-facing VM lifecycle tool.

Existing workspace disks automatically receive the updated bridge, desktop and protections on their next start, followed by a controlled restart. The first desktop update installs packages inside the guest and can take several minutes; the viewer shows preparation status and expandable output. Project files and the workspace's chosen computer remain intact. An update failure prevents bot tools from starting and reports an error; it never falls back to the host. `process` is accepted as an assignment alias for `terminal`, including when creating child bots; both share one permission.

The viewer uses [noVNC](https://novnc.com/noVNC/docs/API.html) with [TigerVNC](https://tigervnc.org/doc/Xvnc.html). An authenticated API request issues a 30-second, single-use WebSocket ticket tied to the workspace's current boot. The API token never appears in viewer URLs. QEMU forwards only the display port to a dynamically allocated host loopback port; VNC has a separate password rotated on every boot. The renderer requests guest resolution changes to match its panel, with temporary proportional scaling while the guest adjusts. Closing the view disconnects the viewer and leaves apps, bots and the VM running. Clipboard sharing and VM power controls are not exposed by the viewer.

## Configure Mukai

For manual setup, set absolute paths in Mukai's environment before launching. Automatic setup does not require these variables. PowerShell example:

```powershell
$env:MUKAI_QEMU_BINARY = 'C:\Program Files\qemu\qemu-system-x86_64.exe'
$env:MUKAI_QEMU_IMAGE = 'C:\MukaiImages\prepared-mukai.qcow2'
npm run dev
```

On Linux/macOS, set those same variables using `export`. `MUKAI_QEMU_ACCEL` optionally overrides the host default with `whpx`, `kvm`, `hvf`, or `tcg`. The creation dialog checks file availability; the first boot verifies that QEMU, acceleration and the guest daemon actually work. A configured path alone does not establish image health.

Create a workspace, choose **Linux VM**, then create a bot. Try `uname -a`, write a file with `file_operations`, run a background process, and open a page with `browser`. Project directory: `/home/mukai/workspace`. VM size: 2 vCPUs, 2 GiB RAM. Settings → Workspace shows state and start/stop controls. Stopping ends running guest processes and browser sessions. Their session IDs do not survive restart; disk files do.

Browser targets `mukai` and `chrome` use one persistent workspace Chrome profile inside the VM. Bots and conversations share its website logins, while each conversation uses a separate native window with its own tabs. `chrome-default` instead connects to the main Chrome opened from the Linux desktop, sharing accounts already signed in there. Both profiles remain inside the guest; neither can attach to the laptop's browser. Tool ownership still prevents controlling another bot's tabs, and existing personal tabs are left open.

For named guest Chrome profiles such as Personal and Work, `browser` action `profiles` discovers their IDs and display names inside the VM. Pass a returned `profileId` with `open` and `target: "chrome-default"`. Each conversation/profile pair has its own window; profile cookies stay separate and `tab.profile` reports the verified actual profile. Discovery never reads host browser profiles. Manage profiles in guest Chrome itself; unavailable or mismatched profiles fail without switching to another profile.

For main Chrome, open Chrome **inside the VM**, visit `chrome://inspect/#remote-debugging`, enable remote debugging, then ask the bot to use main Chrome and allow Chrome's native connection request. Chrome 144 or newer is required. A denied or unavailable connection returns setup instructions rather than opening a different profile. Disconnecting leaves personal tabs open while the VM remains running; stopping the VM ends all guest browser sessions. New tool windows inherit cookies and persistent site data; state limited to an existing tab (such as sessionStorage) is not copied. See [Chrome's connection documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect). Old conversation profiles remain on disk and are not automatically merged.

## Storage and failures

Disks live under Mukai's private data directory at `computers/<workspace-id>/disk.qcow2`. Screenshots are copied into managed host artifact storage; their tool result's `path` remains a guest path for the image tool. Text artifact downloads read from the guest through the bridge. File change history records file-tool mutations, as in local mode; shell writes are not automatically tracked.

Boot waits up to 120 seconds. An individual bridge request waits up to 45 seconds, independently of a command's configured lifetime. Commands return a process session after their yield time; use `process` for longer work. Abort messages cancel active guest requests. Cancelling a caller waiting for a shared boot does not stop another bot's boot. No failed VM operation executes on the host.

Graceful stop sends an ACPI power-down request through a private QMP connection, then terminates QEMU after 15 seconds if needed. The control listener closes once QEMU connects, before the guest boots. Forced termination can lose unsaved writes. After a host crash, a recorded live VM PID blocks another launch against the disk. Inspect and close the old QEMU process yourself; Mukai deliberately does not kill an unknown PID or attach to an orphan. A disconnected guest bridge can authenticate again and restore tool access without rebooting. Retrying a tool while the bridge is disconnected never powers off a still-running VM; if the bridge does not recover, use Stop before Start.

VM diagnostics are written to `logs/errors.log` in the same private data directory and mirrored to the app terminal. Events include launch/readiness, bridge disconnections and protocol failures, request timeouts, controller stop reasons, forced termination, QEMU exit codes/signals, and QMP shutdown/suspend/panic notifications. A request timeout also triggers a bounded QMP status query to distinguish a running guest from a paused or unresponsive VM. Each entry identifies the workspace. Tool arguments and boot credentials are omitted. These logs distinguish a failed tool bridge from an exited or suspended VM and survive app restarts.

## Boundary and verification

The guest has outbound user-mode networking and can reach network services, including reachable host services. VM mode isolates OS execution and storage; it is not a network deny policy or a guarantee against hypervisor vulnerabilities. Model credentials and the Mukai API token are not passed to QEMU or the guest. The bridge accepts result frames and cannot invoke arbitrary host callbacks.

Automated tests cover framing, process ownership, guest dispatch, routing, cancellation, persistence, launch arguments, API guards, setup retries/resumption, checksum failures, seed delivery and publishing only after successful tool verification. Architecture tests cover x64/ARM image selection, hardware arguments, UEFI discovery through Homebrew symlinks, native Node archives, ARM console output, architecture mismatches, legacy x64 manifests, and ARM bridge restart persistence. Installation and provisioning orchestration use mocked OS commands in tests. Real Ubuntu provisioning and subsequent boots have been exercised on Windows WHPX, including terminal commands, file writes, Chrome navigation and browser snapshots. Apple Silicon HVF provisioning, Chromium's native consent flow, Linux KVM and Intel macOS HVF still require real host validation before shipping this preview. The development Mac used for the ARM implementation had less than the required 12 GiB free, so no complete ARM VM provisioning run was performed there.

For an opt-in real VM acceptance test, build the guest bundle, set `MUKAI_QEMU_BINARY`, `MUKAI_QEMU_IMAGE` and optionally `MUKAI_QEMU_ACCEL`, then run `npx tsx scripts/test-vm-guardrails.ts`. It clones the prepared image into a temporary directory, exercises an in-place upgrade, admin access, power/bridge guardrails, Chrome/screenshots/images, shared files, and controller restart persistence, then removes only its test clone. Browser checks include a disposable main-profile stand-in with existing cookies, independent conversation windows, preserving personal tabs during disconnect, and reconnecting. The stand-in substitutes endpoint discovery and native consent; the Chrome approval dialog still needs manual acceptance testing.

After `npm run build`, `npx tsx scripts/run-computer-smoke.ts` exercises the real Electron viewer with a temporary profile and cloned disk, including guest resolution changes, visible Chrome, keyboard input, preservation of the chat draft, and reconnecting without stopping the guest. It saves `artifacts/computer-view.png` and cleans up its disposable profile and disk.

Provisioning disables the serial login service and writes installer output to a guest log independently of console delivery. Ubuntu's missing firmware modules are installed before enabling the bridge; its daemon files are readable by the guest account. x64 launches use the Nehalem CPU baseline to expose SSE4.2 for current native dependencies; ARM launches use the host CPU with HVF and Cortex-A72 with TCG. Failure details retain the installer output instead of the subsequent shutdown messages.

Architecture-specific QEMU choices live in `src/server/computer/qemuPlatform.ts`. Setup, accelerator probing and workspace startup use the same hardware arguments. Saved automatic setup records include their CPU architecture and firmware path; old records default to x64. Guest installer changes live in `scripts/guest/`; the host never executes these scripts. Browser executable selection is passed explicitly from the guest dispatcher, leaving local Chrome discovery unchanged.

References: [QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html), [firmware configuration](https://www.qemu.org/docs/master/specs/fw_cfg.html), [Windows acceleration](https://www.qemu.org/docs/master/system/whpx.html).
