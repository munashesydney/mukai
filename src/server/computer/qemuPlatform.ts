import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export type QemuArchitecture = 'x64' | 'arm64';
export interface QemuBootConfig {
  architecture?: QemuArchitecture;
  accelerator: string;
  firmware?: string;
}

/** Host-native guests only. Keep platform decisions shared by setup, probing and runtime. */
export function qemuPlatform(hostArch = arch(), hostPlatform = platform()) {
  if (hostArch !== 'x64' && !(hostArch === 'arm64' && hostPlatform === 'darwin'))
    throw new Error('Linux VM mode supports x64 computers and Apple Silicon Macs.');
  const architecture: QemuArchitecture = hostArch;
  return {
    architecture,
    binary: `qemu-system-${architecture === 'arm64' ? 'aarch64' : 'x86_64'}${hostPlatform === 'win32' ? '.exe' : ''}`,
    image: `noble-server-cloudimg-${architecture === 'arm64' ? 'arm64' : 'amd64'}.img`,
    console: architecture === 'arm64' ? ('ttyAMA0' as const) : ('ttyS0' as const),
    accelerator: hostPlatform === 'win32' ? 'whpx' : hostPlatform === 'darwin' ? 'hvf' : 'kvm',
  };
}

export function qemuMachineArguments(config: QemuBootConfig, boot = true) {
  const architecture = config.architecture || qemuPlatform().architecture;
  if (architecture === 'x64') {
    // WHPX can expose host CET even with Nehalem's pre-XSAVE feature set. Use
    // host features so Linux can save CET state; hide unsupported nested VMX.
    // Other accelerators retain the SSE4.2 baseline for Node/Chrome dependencies.
    const cpu = config.accelerator === 'whpx' ? 'host,vmx=off' : 'Nehalem';
    return ['-machine', 'q35', '-accel', config.accelerator, '-cpu', cpu];
  }
  if (boot && !config.firmware) throw new Error('ARM64 VM boot requires QEMU UEFI firmware.');
  // ARM RAM starts at 1 GiB; disabling highmem leaves only 3 GiB for RAM.
  // Allow the default 4 GiB allocation and larger workspace settings to fit.
  return [
    '-machine',
    'virt,highmem=on',
    '-accel',
    config.accelerator,
    '-cpu',
    config.accelerator === 'tcg' ? 'cortex-a72' : 'host',
    ...(boot ? ['-bios', config.firmware!] : []),
  ];
}

/** Homebrew includes EDK2 with QEMU. Resolve symlinks for nonstandard brew prefixes too. */
export async function findQemuFirmware(binary: string, override?: string) {
  if (override) {
    if (!isAbsolute(override) || !(await stat(override).catch(() => undefined))?.isFile())
      throw new Error('MUKAI_QEMU_FIRMWARE must point to an absolute ARM64 UEFI firmware file.');
    await access(override, constants.R_OK);
    return override;
  }
  const resolved = await realpath(binary);
  const candidates = [
    join(dirname(resolved), '..', 'share', 'qemu', 'edk2-aarch64-code.fd'),
    join(dirname(binary), '..', 'share', 'qemu', 'edk2-aarch64-code.fd'),
    '/opt/homebrew/share/qemu/edk2-aarch64-code.fd',
    '/usr/local/share/qemu/edk2-aarch64-code.fd',
  ];
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      /* Next QEMU installation location. */
    }
  }
  throw new Error(
    'ARM64 UEFI firmware was not found. Reinstall QEMU with Homebrew, or set MUKAI_QEMU_FIRMWARE to edk2-aarch64-code.fd.',
  );
}
