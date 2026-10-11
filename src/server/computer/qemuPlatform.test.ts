import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findQemuFirmware, qemuMachineArguments, qemuPlatform } from './qemuPlatform';
import { qemuArguments, qemuConfig, qemuSetup } from './qemuComputer';

const host = vi.hoisted(() => ({ architecture: 'x64', platform: 'win32' as NodeJS.Platform }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  arch: () => host.architecture,
  platform: () => host.platform,
}));
let directory: string;
beforeEach(async () => {
  host.architecture = 'x64';
  host.platform = 'win32';
  directory = await mkdtemp(join(tmpdir(), 'mukai-qemu-platform-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('host-native QEMU configuration', () => {
  it.each([
    ['x64', 'win32', 'qemu-system-x86_64.exe', 'amd64', 'whpx', 'ttyS0'],
    ['x64', 'darwin', 'qemu-system-x86_64', 'amd64', 'hvf', 'ttyS0'],
    ['x64', 'linux', 'qemu-system-x86_64', 'amd64', 'kvm', 'ttyS0'],
    ['arm64', 'darwin', 'qemu-system-aarch64', 'arm64', 'hvf', 'ttyAMA0'],
  ] as const)(
    'selects the native profile for %s %s',
    (architecture, os, binary, image, accelerator, console) => {
      expect(qemuPlatform(architecture, os)).toMatchObject({
        architecture,
        binary,
        image: `noble-server-cloudimg-${image}.img`,
        accelerator,
        console,
      });
    },
  );
  it('uses host features without nested VMX for WHPX probing and guest boot', () => {
    const config = { architecture: 'x64' as const, accelerator: 'whpx' };
    const args = qemuMachineArguments(config);
    expect(args).toEqual(['-machine', 'q35', '-accel', 'whpx', '-cpu', 'host,vmx=off']);
    expect(qemuMachineArguments(config, false)).toEqual(args);
    const runtime = qemuArguments(directory, 1234, {
      ...config,
      binary: '/qemu',
      image: '/base',
    });
    expect(runtime.slice(2, 2 + args.length)).toEqual(args);
  });
  it.each(['kvm', 'hvf', 'tcg'])('retains the x64 CPU baseline for %s', (accelerator) => {
    expect(qemuMachineArguments({ architecture: 'x64', accelerator })).toEqual([
      '-machine',
      'q35',
      '-accel',
      accelerator,
      '-cpu',
      'Nehalem',
    ]);
  });
  it('uses the same ARM hardware for probe and boot, with an emulation CPU for TCG', () => {
    const config = {
      architecture: 'arm64' as const,
      accelerator: 'hvf',
      firmware: '/qemu/edk2-aarch64-code.fd',
    };
    expect(qemuMachineArguments(config)).toEqual([
      ...qemuMachineArguments(config, false),
      '-bios',
      config.firmware,
    ]);
    expect(qemuMachineArguments({ ...config, accelerator: 'tcg' })).toContain('cortex-a72');
    expect(() => qemuMachineArguments({ architecture: 'arm64', accelerator: 'hvf' })).toThrow(
      'firmware',
    );
  });
  it('keeps the ARM bridge, boot token and desktop forwarding in the runtime command', () => {
    const args = qemuArguments(
      directory,
      1234,
      {
        binary: '/qemu',
        image: '/base',
        architecture: 'arm64',
        accelerator: 'hvf',
        firmware: '/firmware with spaces.fd',
      },
      1235,
      1236,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        'virt,highmem=off',
        'host',
        '-bios',
        '/firmware with spaces.fd',
        'virtio-serial-pci',
        'virtserialport,chardev=mukai,name=com.mukai.agent',
      ]),
    );
    expect(args.join(' ')).toContain('opt/com.mukai/token');
    expect(args.join(' ')).toContain('hostfwd=tcp:127.0.0.1:1236-:5901');
    expect(args.join(' ')).not.toMatch(/q35|Nehalem|virtfs|fsdev/);
  });
  it('refuses architecture mismatches and keeps unsupported hosts usable in local mode', async () => {
    host.architecture = 'arm64';
    host.platform = 'darwin';
    expect(
      await qemuSetup({ binary: '/qemu', image: '/base', architecture: 'x64', accelerator: 'hvf' }),
    ).toMatchObject({ available: false, reason: expect.stringContaining('architecture') });
    host.architecture = 'riscv64';
    host.platform = 'linux';
    expect(() => qemuConfig()).not.toThrow();
    expect((await qemuSetup()).available).toBe(false);
    expect(() => qemuPlatform('arm64', 'win32')).toThrow('Apple Silicon');
  });
});

describe('ARM UEFI firmware discovery', () => {
  it.skipIf(process.platform === 'win32')(
    'locates firmware relative to a Homebrew binary behind a symlink',
    async () => {
      const bin = join(directory, 'Cellar', 'qemu', 'bin');
      const share = join(directory, 'Cellar', 'qemu', 'share', 'qemu');
      await mkdir(bin, { recursive: true });
      await mkdir(share, { recursive: true });
      const binary = join(bin, 'qemu-system-aarch64');
      const firmware = join(share, 'edk2-aarch64-code.fd');
      await writeFile(binary, 'qemu');
      await writeFile(firmware, 'firmware');
      const link = join(directory, 'qemu-system-aarch64');
      await symlink(binary, link);
      expect(await findQemuFirmware(link)).toBe(await realpath(firmware));
    },
  );
  it('validates an explicit override and refuses directories and missing files', async () => {
    const firmware = join(directory, 'custom firmware.fd');
    await writeFile(firmware, 'firmware');
    expect(await findQemuFirmware('/unused', firmware)).toBe(firmware);
    await expect(findQemuFirmware('/unused', directory)).rejects.toThrow('firmware');
    await expect(findQemuFirmware('/unused', 'relative.fd')).rejects.toThrow('absolute');
    await expect(findQemuFirmware('/unused', join(directory, 'missing.fd'))).rejects.toThrow();
  });
});
