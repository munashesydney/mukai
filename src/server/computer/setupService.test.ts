import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, writeFile, readFile, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { ComputerSetupService } from './setupService';
import { setupProcess } from './setupProcess';
import { downloadImage, downloadVerifiedFile } from './setupDownload';
import { probeAccelerator } from './setupProbe';
import { guestFiles } from './bundleFiles';
import { prepareLinuxKvm } from './linuxKvm';
import { qemuArguments, type QemuConfig } from './qemuComputer';

const guestProbe = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn() }));
const host = vi.hoisted(() => ({ architecture: 'x64', platform: process.platform }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  arch: () => host.architecture,
  platform: () => host.platform,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: vi.fn((await original<typeof import('node:fs/promises')>()).access),
  statfs: vi.fn(),
}));

vi.mock('./setupProcess', () => ({ setupProcess: vi.fn() }));
vi.mock('./setupProbe', () => ({ probeAccelerator: vi.fn() }));
vi.mock('./linuxKvm', () => ({ prepareLinuxKvm: vi.fn() }));
vi.mock('./setupDownload', async (original) => ({
  ...(await original<typeof import('./setupDownload')>()),
  downloadImage: vi.fn(),
  downloadVerifiedFile: vi.fn(),
}));
vi.mock('./qemuComputer', async (original) => ({
  ...(await original<typeof import('./qemuComputer')>()),
  QemuComputer: class {
    constructor(...args: unknown[]) {
      guestProbe.create(...args);
    }
    request = guestProbe.request;
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

let directory: string, bundle: string;
const services: ComputerSetupService[] = [];
beforeEach(async () => {
  host.architecture = 'x64';
  host.platform = process.platform;
  vi.mocked(statfs).mockResolvedValue({ bavail: 20 * 1024 ** 3, bsize: 1 } as Awaited<
    ReturnType<typeof statfs>
  >);
  vi.mocked(probeAccelerator).mockResolvedValue({ code: 0, output: '' });
  vi.mocked(prepareLinuxKvm).mockResolvedValue(undefined);
  guestProbe.request.mockResolvedValue({ exitCode: 0, output: 'Linux\nx86_64\nv24\nChrome' });
  directory = await mkdtemp(join(tmpdir(), 'mukai-auto-setup-'));
  bundle = join(directory, 'bundle');
  await mkdir(bundle);
  for (const name of guestFiles) await writeFile(join(bundle, name), 'fixture');
  vi.stubEnv('MUKAI_QEMU_BINARY', process.execPath);
  vi.stubEnv('MUKAI_QEMU_IMAGE', '');
  vi.stubEnv('MUKAI_QEMU_ACCEL', 'tcg');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(
        async () => new Response('a'.repeat(64) + ' *noble-server-cloudimg-amd64.img'),
      ),
  );
  vi.mocked(setupProcess).mockImplementation(async (_binary, args, _signal, _input, onOutput) => {
    if (args.includes('-smbios')) onOutput?.('MUKAI_IMAGE_READY\n');
    return { code: 0, output: '' };
  });
  vi.mocked(downloadImage).mockImplementation(
    async (_url, destination, _checksum, _signal, progress) => {
      await writeFile(destination, 'image fixture');
      progress(20, 20);
    },
  );
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function service() {
  const value = new ComputerSetupService(directory, bundle);
  services.push(value);
  await value.initialize();
  return value;
}
describe('automatic computer setup', () => {
  it('installs QEMU without WinGet and continues through Linux verification', async () => {
    host.platform = 'win32';
    vi.stubEnv('MUKAI_QEMU_BINARY', '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('LOCALAPPDATA', join(directory, 'local'));
    vi.stubEnv('ProgramFiles', join(directory, 'program-files'));
    const qemu = join(process.env.ProgramFiles!, 'qemu', 'qemu-system-x86_64.exe');
    vi.mocked(downloadVerifiedFile).mockImplementation(async (_url, path) => {
      await writeFile(path, 'verified installer fixture');
    });
    vi.mocked(setupProcess).mockImplementation(async (_binary, args, _signal, _input, onOutput) => {
      if (args.includes('-EncodedCommand')) {
        await mkdir(join(process.env.ProgramFiles!, 'qemu'), { recursive: true });
        await writeFile(qemu, 'qemu fixture');
      }
      if (args.includes('-smbios')) onOutput?.('MUKAI_IMAGE_READY\n');
      return { code: 0, output: '' };
    });
    const setup = await service();
    expect(setupProcess).not.toHaveBeenCalled();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(downloadVerifiedFile).toHaveBeenCalledOnce();
    expect(downloadImage).toHaveBeenCalledOnce();
    expect(setup.configuration().binary).toBe(qemu);
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, 'computer-setup', 'setup.log'), 'utf8')).toContain(
        'Windows Package Manager is unavailable',
      ),
    );
    expect(guestProbe.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ binary: qemu }),
    );
    expect(vi.mocked(setupProcess).mock.calls.some(([binary]) => binary === 'winget.exe')).toBe(
      false,
    );
  });
  it('reports installer download failures before preparing Linux or publishing a base image', async () => {
    host.platform = 'win32';
    vi.stubEnv('MUKAI_QEMU_BINARY', '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('LOCALAPPDATA', join(directory, 'local'));
    vi.stubEnv('ProgramFiles', join(directory, 'program-files'));
    vi.mocked(downloadVerifiedFile).mockRejectedValueOnce(
      new Error('QEMU installer checksum did not match.'),
    );
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('checksum did not match');
    expect((await setup.status()).message).toContain('Install QEMU for Windows');
    expect(setupProcess).not.toHaveBeenCalled();
    expect(downloadImage).not.toHaveBeenCalled();
    expect(guestProbe.create).not.toHaveBeenCalled();
    await expect(readFile(join(directory, 'computer-setup', 'ready.json'))).rejects.toThrow();
  });
  it('uses working KVM without requesting permission repair', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(setup.configuration().accelerator).toBe('kvm');
    expect(prepareLinuxKvm).not.toHaveBeenCalled();
    expect((await setup.status()).warning).toBeUndefined();
  });
  it('retests repaired KVM before provisioning and avoids software emulation when repair succeeds', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    vi.mocked(probeAccelerator).mockResolvedValueOnce({ code: 1, output: 'Permission denied' });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(prepareLinuxKvm).toHaveBeenCalledOnce();
    expect(setup.configuration().accelerator).toBe('kvm');
    expect(probeAccelerator).toHaveBeenCalledTimes(2);
  });
  it('provisions, verifies and persists software emulation with a visible performance and login warning', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    vi.mocked(probeAccelerator).mockImplementation(async (_binary, accelerator) => ({
      code: accelerator === 'tcg' ? 0 : 1,
      output: accelerator === 'tcg' ? '' : 'KVM permission denied',
    }));
    vi.mocked(prepareLinuxKvm).mockResolvedValue('Log out and back in to activate KVM access.');
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(setup.configuration().accelerator).toBe('tcg');
    expect((await setup.status()).warning).toContain('considerably slower');
    expect((await setup.status()).warning).toContain('Log out and back in');
    const provision = vi
      .mocked(setupProcess)
      .mock.calls.find(([, args]) => args.includes('-smbios'))!;
    expect(provision[1]).toEqual(expect.arrayContaining(['-accel', 'tcg']));
    expect(provision[5]).toBe(2 * 60 * 60 * 1000);
    expect(guestProbe.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accelerator: 'tcg' }),
    );
    const next = await service();
    expect(next.configuration().accelerator).toBe('tcg');
    expect((await next.status()).warning).toContain('Log out and back in');
    expect(downloadImage).toHaveBeenCalledOnce();
    vi.mocked(probeAccelerator).mockResolvedValue({ code: 0, output: '' });
    const freshLogin = await service();
    expect(freshLogin.configuration().accelerator).toBe('kvm');
    expect((await freshLogin.status()).warning).toBeUndefined();
    expect(downloadImage).toHaveBeenCalledOnce();
  });
  it('fails before downloading when both KVM and software emulation fail, preserving diagnostics', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    vi.mocked(probeAccelerator).mockImplementation(async (_binary, accelerator) => ({
      code: 1,
      output: accelerator === 'tcg' ? 'TCG startup failed' : 'KVM unavailable',
    }));
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('KVM or software emulation');
    expect((await setup.status()).message).toContain('TCG startup failed');
    expect(downloadImage).not.toHaveBeenCalled();
  });
  it('respects an explicit KVM override instead of silently changing it', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', 'kvm');
    vi.mocked(probeAccelerator).mockResolvedValue({ code: 1, output: 'KVM unavailable' });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('requested kvm');
    expect(probeAccelerator).not.toHaveBeenCalledWith(
      expect.anything(),
      'tcg',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(downloadImage).not.toHaveBeenCalled();
  });
  it('uses software emulation on a prepared VM when KVM is lost on the next startup', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    const root = join(directory, 'computer-setup');
    await mkdir(root);
    const image = join(root, 'prepared.qcow2');
    await writeFile(image, 'prepared image');
    await writeFile(
      join(root, 'ready.json'),
      JSON.stringify({ binary: process.execPath, image, accelerator: 'kvm' }),
    );
    vi.mocked(probeAccelerator).mockImplementation(async (_binary, accelerator) => ({
      code: accelerator === 'tcg' ? 0 : 1,
      output: '',
    }));
    const setup = await service();
    expect((await setup.status()).available).toBe(true);
    expect(setup.configuration().accelerator).toBe('tcg');
    expect((await setup.status()).warning).toContain('considerably slower');
    expect(prepareLinuxKvm).not.toHaveBeenCalled();
    expect(downloadImage).not.toHaveBeenCalled();
  });
  it('keeps a prepared VM unavailable if neither accelerator works, then allows a successful retry', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_ACCEL', '');
    const root = join(directory, 'computer-setup');
    await mkdir(root);
    const image = join(root, 'prepared.qcow2');
    await writeFile(image, 'prepared image');
    await writeFile(
      join(root, 'ready.json'),
      JSON.stringify({ binary: process.execPath, image, accelerator: 'kvm' }),
    );
    vi.mocked(probeAccelerator).mockResolvedValue({ code: 1, output: 'unavailable' });
    const setup = await service();
    expect((await setup.status()).available).toBe(false);
    expect((await setup.status()).message).toContain('KVM or software emulation');
    expect(downloadImage).not.toHaveBeenCalled();
    vi.mocked(probeAccelerator).mockResolvedValue({ code: 0, output: '' });
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(setup.configuration().accelerator).toBe('kvm');
  });

  it('gives terminal installation instructions when Linux has no pkexec', async () => {
    host.platform = 'linux';
    vi.stubEnv('MUKAI_QEMU_BINARY', '');
    if (process.getuid) vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(access).mockImplementation(async (path, mode) => {
      if (path === '/usr/bin/apt-get') return;
      if (String(path).includes('qemu-system-') || path === '/usr/bin/pkexec')
        throw new Error('ENOENT');
      return original.access(path, mode);
    });
    try {
      const setup = await service();
      await setup.start();
      await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
      expect((await setup.status()).message).toContain(
        'sudo apt-get install -y qemu-system-x86 qemu-utils',
      );
      expect((await setup.status()).message).not.toContain('ENOENT');
      expect(setupProcess).not.toHaveBeenCalled();
      expect(downloadImage).not.toHaveBeenCalled();
    } finally {
      vi.mocked(access).mockImplementation(original.access);
      vi.restoreAllMocks();
    }
  });

  it('provisions an Apple Silicon image with UEFI, ARM console and matching verification boot', async () => {
    host.architecture = 'arm64';
    host.platform = 'darwin';
    const firmware = join(directory, 'edk2-aarch64-code.fd');
    await writeFile(firmware, 'firmware');
    vi.stubEnv('MUKAI_QEMU_FIRMWARE', firmware);
    vi.stubEnv('MUKAI_QEMU_ACCEL', 'hvf');
    vi.mocked(fetch).mockImplementation(
      async () => new Response('b'.repeat(64) + ' *noble-server-cloudimg-arm64.img'),
    );
    guestProbe.request.mockResolvedValue({ exitCode: 0, output: 'Linux\naarch64\nv24\nChromium' });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(downloadImage).toHaveBeenCalledWith(
      expect.stringContaining('noble-server-cloudimg-arm64.img'),
      expect.any(String),
      'b'.repeat(64),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const args = vi
      .mocked(setupProcess)
      .mock.calls.find(([, args]) => args.includes('-smbios'))![1];
    expect(args).toEqual(expect.arrayContaining(['virt,highmem=on', 'host', '-bios', firmware]));
    expect(args[args.indexOf('-m') + 1]).toBe('2048');
    expect(args).not.toContain('Nehalem');
    expect(probeAccelerator).toHaveBeenCalledWith(
      process.execPath,
      'hvf',
      expect.any(AbortSignal),
      expect.any(Function),
      { architecture: 'arm64', accelerator: 'hvf' },
    );
    expect(guestProbe.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ architecture: 'arm64', firmware, accelerator: 'hvf' }),
    );
    const [verificationDirectory, verificationConfig] = guestProbe.create.mock.calls[0] as [
      string,
      QemuConfig,
    ];
    const verificationArgs = qemuArguments(verificationDirectory, 1234, verificationConfig);
    expect(verificationArgs[verificationArgs.indexOf('-m') + 1]).toBe('4096');
    expect(verificationArgs[verificationArgs.indexOf('-machine') + 1]).toBe('virt,highmem=on');
    expect(setup.configuration()).toMatchObject({ architecture: 'arm64', firmware });
    const next = await service();
    expect((await next.status()).available).toBe(true);
    expect(downloadImage).toHaveBeenCalledOnce();
  });
  it('does not accept a prepared image for the wrong architecture', async () => {
    guestProbe.request.mockResolvedValue({ exitCode: 0, output: 'Linux\naarch64\nv24\nChromium' });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('tool check');
    await expect(readFile(join(directory, 'computer-setup', 'ready.json'))).rejects.toThrow();
  });
  it('keeps legacy x64 manifests available without provisioning again', async () => {
    const root = join(directory, 'computer-setup');
    await mkdir(root);
    const image = join(root, 'old.qcow2');
    await writeFile(image, 'legacy image');
    await writeFile(
      join(root, 'ready.json'),
      JSON.stringify({ binary: process.execPath, image, accelerator: 'tcg' }),
    );
    const setup = await service();
    expect((await setup.status()).available).toBe(true);
    expect(setup.configuration().architecture).toBe('x64');
    expect(downloadImage).not.toHaveBeenCalled();
  });
  it('rejects low disk space before installing or downloading', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: 9 * 1024 ** 3, bsize: 1 } as Awaited<
      ReturnType<typeof statfs>
    >);
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('12 GiB');
    expect(setupProcess).not.toHaveBeenCalled();
    expect(downloadImage).not.toHaveBeenCalled();
  });
  it('deduplicates requests, prepares Linux and persists ready configuration', async () => {
    const setup = await service();
    await Promise.all([setup.start(), setup.start(), setup.start()]);
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(downloadImage).toHaveBeenCalledOnce();
    expect(setup.configuration().image).toBe(
      join(directory, 'computer-setup', 'mukai-linux.qcow2'),
    );
    expect(
      JSON.parse(await readFile(join(directory, 'computer-setup', 'ready.json'), 'utf8')),
    ).toMatchObject({ accelerator: 'tcg' });
    const next = await service();
    expect((await next.status()).available).toBe(true);
    expect(downloadImage).toHaveBeenCalledOnce();
  });
  it('keeps failed preparation unavailable and allows a retry', async () => {
    vi.mocked(downloadImage).mockRejectedValueOnce(new Error('Offline'));
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toBe('Offline');
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
  });
  it('does not run installations on ordinary startup or for externally configured images', async () => {
    const setup = await service();
    expect((await setup.status()).phase).toBe('idle');
    expect(setupProcess).not.toHaveBeenCalled();
    const image = join(directory, 'external.qcow2');
    await writeFile(image, 'external');
    vi.stubEnv('MUKAI_QEMU_IMAGE', image);
    expect((await setup.start()).available).toBe(true);
    expect(setupProcess).not.toHaveBeenCalled();
  });
  it('never publishes a base image when its guest tools fail verification', async () => {
    guestProbe.request.mockResolvedValue({ exitCode: 1, output: 'node: not found' });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('tool check');
    await expect(readFile(join(directory, 'computer-setup', 'ready.json'))).rejects.toThrow();
    await expect(
      readFile(join(directory, 'computer-setup', 'mukai-linux.qcow2')),
    ).rejects.toThrow();
  });
  it('reports a provisioning failure without verifying or publishing the image', async () => {
    vi.mocked(setupProcess).mockImplementation(async (_binary, args, _signal, _input, onOutput) => {
      if (args.includes('-smbios')) {
        onOutput?.('installer failed\nMUKAI_IMAGE_FAILED\n');
        onOutput?.('shutdown noise\n'.repeat(400));
      }
      return { code: 0, output: '' };
    });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('Setup details');
    expect((await setup.status()).detail).toContain('installer failed');
    expect((await setup.status()).detail).not.toContain('shutdown noise');
    expect(guestProbe.request).not.toHaveBeenCalled();
    await expect(readFile(join(directory, 'computer-setup', 'ready.json'))).rejects.toThrow();
  });
  it('does not overwrite a preparation disk still owned by a live process', async () => {
    const building = join(directory, 'computer-setup', 'building');
    await mkdir(building, { recursive: true });
    await writeFile(join(building, 'preparation.pid'), String(process.pid));
    await writeFile(join(building, 'disk.qcow2'), 'do not overwrite');
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('still running');
    expect(await readFile(join(building, 'disk.qcow2'), 'utf8')).toBe('do not overwrite');
    expect(guestProbe.request).not.toHaveBeenCalled();
  });
  it('automatically resumes an interrupted setup at app startup', async () => {
    const root = join(directory, 'computer-setup');
    await mkdir(root);
    await writeFile(join(root, 'progress.json'), JSON.stringify({ phase: 'downloading' }));
    const setup = await service();
    await vi.waitFor(async () => expect((await setup.status()).available).toBe(true));
    expect(downloadImage).toHaveBeenCalledOnce();
  });
  it('rejects missing packaged tools before invoking an installer', async () => {
    const setup = new ComputerSetupService(directory, join(directory, 'missing'));
    services.push(setup);
    await setup.initialize();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('guest bundle is missing');
    expect(setupProcess).not.toHaveBeenCalled();
  });
  it.skipIf(platform() !== 'win32')(
    'reports a Windows reboot without starting downloads',
    async () => {
      vi.stubEnv('MUKAI_QEMU_ACCEL', 'whpx');
      vi.mocked(probeAccelerator).mockResolvedValue({ code: 1, output: '' });
      vi.mocked(setupProcess).mockImplementation(async (binary) => ({
        code: binary === 'powershell.exe' ? 3010 : 1,
        output: '',
      }));
      const setup = await service();
      await setup.start();
      await vi.waitFor(async () => expect((await setup.status()).phase).toBe('reboot-required'));
      expect(downloadImage).not.toHaveBeenCalled();
      expect((await setup.status()).message).toContain('Restart Windows');
    },
  );
});
