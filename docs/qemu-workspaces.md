# QEMU workspace v1

Workspace creation offers **Local machine** or **Linux VM (preview)**. Existing workspaces stay local. A workspace's computer type is fixed when created. All bots in a VM workspace share one persistent guest disk; their process/browser sessions retain bot and conversation ownership checks.

## Supported in this version

- Terminal, background processes, bounded logs, stdin, wait and termination inside Linux.
- Workspace file operations with change history and downloadable text artifacts.
- Guest image metadata and vision input, including absolute guest paths.
- Headless guest Chrome snapshots, interactions and screenshots saved as Mukai artifacts.
- Automatic startup on first computer tool call; manual start/stop/status in Settings → Workspace; shutdown when Mukai closes.
- Host-side chats, model connections, permissions, bots, memory, skills, web search and pursuits.

Custom tools/routes are unavailable in VM v1, including through management APIs. They never fall back to host Node. There are no host folder mounts, live VM browser/desktop display, preview port forwarding, snapshots, ARM guests, or automatic orphan recovery yet. Uploads are model attachments; there is no guest upload/import UI yet. Local mode retains its existing behavior.

## Automatic setup

Choose **Linux VM** in the workspace creation dialog. Mukai installs missing QEMU, checks hardware acceleration, downloads the official Ubuntu 24.04 x86_64 cloud image over HTTPS, verifies its SHA-256, and prepares Node.js 24, Chrome and the guest tools inside a disposable VM. A second boot verifies the guest bridge and installed tools before publishing the base image. The dialog shows progress and enables workspace creation when setup succeeds. Setup continues if the dialog is closed.

Windows uses Winget's `SoftwareFreedomConservancy.QEMU` package and can enable Windows Hypervisor Platform with administrator approval. If Windows requires a reboot, Mukai reports it and resumes when reopened; it never reboots the computer itself. Firmware virtualization must already be enabled. Intel macOS uses an existing Homebrew installation; Ubuntu/Debian uses apt-get with pkexec for administrator approval. Other Linux distributions require manually installing QEMU first. Automatic setup requires an x64 host and at least 12 GiB free on Mukai's data drive. Allow several minutes, internet access and any OS administrator prompts.

Ordinary app startup detects existing setup without installing software for local workspaces. Once VM setup has been requested, unfinished setup resumes on app startup, including after a required Windows restart. Failed setup offers Retry. Retries may download the image again; partial downloads are never used as a base image. Setup files live under `computer-setup/` in Mukai's data directory. Each workspace gets a separate full copy of the prepared 32 GiB virtual disk, so allow additional physical storage as its files grow.

The modal shows activity throughout installation and provisioning, download counts when available, and expandable setup output. A bounded `computer-setup/setup.log` records each attempt; failure details remain available after reopening Mukai. The virtualization check uses a QMP control socket, avoiding Windows QEMU's unreliable piped console input.

Desktop builds include the guest bundle as an application resource. `npm run dev`, `npm run dev:server` and `npm run build` generate it automatically. Environment overrides below remain available for an operator-prepared image.

## Optional manual base image

You can supply a standalone **x86_64 qcow2** image instead of automatic preparation. A normal Ubuntu/Debian installation with systemd and BIOS boot works. Do not use an overlay that depends on another image; every workspace receives a full copy of the base. Allocate enough disk space for the base plus a full copy per workspace.

1. Install QEMU on the host. On Windows, enable Windows Hypervisor Platform and reboot if required. Use an x64 host. Hardware acceleration uses WHPX on Windows, KVM on Linux, or HVF on Intel macOS. `MUKAI_QEMU_ACCEL=tcg` enables slower software emulation for development.
2. In this repository run `npm run build:guest`. This produces `dist/guest/` with the bundled daemon, pinned direct dependency versions, installer and systemd unit.
3. Boot a disposable Ubuntu/Debian guest and copy the contents of `dist/guest/` into it, using SSH/SCP or an ISO. Inside the guest, from that directory, run `sudo sh install.sh`. The installer downloads Node 24 (checks its SHA-256), Google Chrome and required packages, creates the guest account, and enables the daemon. It must run inside QEMU/KVM. The guest account has passwordless sudo **inside this guest** for development work.
4. Shut the guest down cleanly. Use `qemu-img convert -O qcow2 source-disk prepared-mukai.qcow2` if needed to flatten the image. Keep the prepared base offline and unchanged while Mukai uses it. The image must boot without an installer/seed ISO. The guest service activates when Mukai supplies its virtio serial device.

The service does not need a network listener or SSH once prepared. Mukai passes a new identity through QEMU `fw_cfg` on every boot and communicates over a dedicated virtio serial channel. The root service pre-start step loads `qemu_fw_cfg`, reads the boot identity and grants the guest account access to that channel. The daemon itself and shell commands run as `mukai`.

## Configure Mukai

For manual setup, set absolute paths in Mukai's environment before launching. Automatic setup does not require these variables. PowerShell example:

```powershell
$env:MUKAI_QEMU_BINARY = 'C:\Program Files\qemu\qemu-system-x86_64.exe'
$env:MUKAI_QEMU_IMAGE = 'C:\MukaiImages\prepared-mukai.qcow2'
npm run dev
```

On Linux/macOS, set those same variables using `export`. `MUKAI_QEMU_ACCEL` optionally overrides the host default with `whpx`, `kvm`, `hvf`, or `tcg`. The creation dialog checks file availability; the first boot verifies that QEMU, acceleration and the guest daemon actually work. A configured path alone does not establish image health.

Create a workspace, choose **Linux VM**, then create a bot. Try `uname -a`, write a file with `file_operations`, run a background process, and open a page with `browser`. Project directory: `/home/mukai/workspace`. VM size: 2 vCPUs, 2 GiB RAM. Settings → Workspace shows state and start/stop controls. Stopping ends running guest processes and browser sessions. Their session IDs do not survive restart; disk files do.

## Storage and failures

Disks live under Mukai's private data directory at `computers/<workspace-id>/disk.qcow2`. Screenshots are copied into managed host artifact storage; their tool result's `path` remains a guest path for the image tool. Text artifact downloads read from the guest through the bridge. File change history records file-tool mutations, as in local mode; shell writes are not automatically tracked.

Boot waits up to 120 seconds. An individual bridge request waits up to 45 seconds, independently of a command's configured lifetime. Commands return a process session after their yield time; use `process` for longer work. Abort messages cancel active guest requests. Cancelling a caller waiting for a shared boot does not stop another bot's boot. No failed VM operation executes on the host.

Graceful stop asks the guest to power down, then terminates QEMU after 15 seconds if needed. Forced termination can lose unsaved writes. After a host crash, a recorded live VM PID blocks another launch against the disk. Inspect and close the old QEMU process yourself; Mukai deliberately does not kill an unknown PID or attach to an orphan. A failed bridge with a still-running VM requires Stop before Start.

## Boundary and verification

The guest has outbound user-mode networking and can reach network services, including reachable host services. VM mode isolates OS execution and storage; it is not a network deny policy or a guarantee against hypervisor vulnerabilities. Model credentials and the Mukai API token are not passed to QEMU or the guest. The bridge accepts result frames and cannot invoke arbitrary host callbacks.

Automated tests cover framing, process ownership, guest dispatch, routing, cancellation, persistence, launch arguments, API guards, setup retries/resumption, checksum failures, seed delivery and publishing only after successful tool verification. Installation and provisioning orchestration use mocked OS commands in tests. A real image boot must also be checked on each supported host/accelerator before shipping this preview. This development environment has no QEMU installation, so automated validation does not establish WHPX/KVM/HVF operation.

References: [QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html), [firmware configuration](https://www.qemu.org/docs/master/specs/fw_cfg.html), [Windows acceleration](https://www.qemu.org/docs/master/system/whpx.html).
