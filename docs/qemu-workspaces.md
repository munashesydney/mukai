# QEMU workspace v1

Workspace creation offers **Local machine** or **Linux VM (preview)**. Existing workspaces stay local. A workspace's computer type is fixed when created. All bots in a VM workspace share one persistent guest disk; their process/browser sessions retain bot and conversation ownership checks.

## Supported in this version

- Terminal, background processes, bounded logs, stdin, wait and termination inside Linux.
- Workspace file operations with change history and downloadable text artifacts.
- Guest image metadata and vision input, including absolute guest paths.
- Headless guest Chrome snapshots, interactions and screenshots saved as Mukai artifacts.
- Automatic startup on first computer tool call; manual start/stop/status in Settings → Workspace; shutdown when Mukai closes.
- Host-side chats, model connections, permissions, bots, memory, skills, web search and pursuits.

Custom tools/routes are unavailable in VM v1, including through management APIs. They never fall back to host Node. There are no host folder mounts, live VM browser/desktop display, preview port forwarding, automatic image downloads, snapshots, ARM guests, or automatic orphan recovery yet. Uploads are model attachments; there is no guest upload/import UI yet. Local mode retains its existing behavior.

## Prepare a base image once

V1 uses an operator-prepared, standalone **x86_64 qcow2** image. QEMU and the image are external prerequisites rather than bundled downloads. A normal Ubuntu/Debian installation with systemd and BIOS boot works. Do not use an overlay that depends on another image; every workspace receives a full copy of the base. Allocate enough disk space for the base plus a full copy per workspace.

1. Install QEMU on the host. On Windows, enable Windows Hypervisor Platform and reboot if required. Use an x64 host. Hardware acceleration uses WHPX on Windows, KVM on Linux, or HVF on Intel macOS. `MUKAI_QEMU_ACCEL=tcg` enables slower software emulation for development.
2. In this repository run `npm run build:guest`. This produces `dist/guest/` with the bundled daemon, pinned direct dependency versions, installer and systemd unit.
3. Boot a disposable Ubuntu/Debian guest and copy the contents of `dist/guest/` into it, using SSH/SCP or an ISO. Inside the guest, from that directory, run `sudo sh install.sh`. The installer downloads Node 24 (checks its SHA-256), Google Chrome and required packages, creates the guest account, and enables the daemon. It must run inside QEMU/KVM. The guest account has passwordless sudo **inside this guest** for development work.
4. Shut the guest down cleanly. Use `qemu-img convert -O qcow2 source-disk prepared-mukai.qcow2` if needed to flatten the image. Keep the prepared base offline and unchanged while Mukai uses it. The image must boot without an installer/seed ISO. The guest service activates when Mukai supplies its virtio serial device.

The service does not need a network listener or SSH once prepared. Mukai passes a new identity through QEMU `fw_cfg` on every boot and communicates over a dedicated virtio serial channel. The root service pre-start step loads `qemu_fw_cfg`, reads the boot identity and grants the guest account access to that channel. The daemon itself and shell commands run as `mukai`.

## Configure Mukai

Before launching Mukai, set absolute paths in its environment. PowerShell example:

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

Automated tests cover framing, process ownership, guest dispatch, routing, cancellation, persistence, launch arguments and API guards. A real image boot must also be checked on each supported host/accelerator before shipping this preview. This development environment has no QEMU installation, so automated validation does not establish WHPX/KVM/HVF operation.

References: [QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html), [firmware configuration](https://www.qemu.org/docs/master/specs/fw_cfg.html), [Windows acceleration](https://www.qemu.org/docs/master/system/whpx.html).
