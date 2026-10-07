import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { ComputerSetupService } from './setupService';
import { setupProcess } from './setupProcess';
import { downloadImage } from './setupDownload';
import { probeAccelerator } from './setupProbe';

const guestProbe = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('./setupProcess', () => ({ setupProcess: vi.fn() }));
vi.mock('./setupProbe', () => ({ probeAccelerator: vi.fn() }));
vi.mock('./setupDownload', async (original) => ({
  ...(await original<typeof import('./setupDownload')>()),
  downloadImage: vi.fn(),
}));
vi.mock('./qemuComputer', async (original) => ({
  ...(await original<typeof import('./qemuComputer')>()),
  QemuComputer: class {
    request = guestProbe.request;
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

let directory: string, bundle: string;
const services: ComputerSetupService[] = [];
beforeEach(async () => {
  vi.mocked(probeAccelerator).mockResolvedValue({ code: 0, output: '' });
  guestProbe.request.mockResolvedValue({ exitCode: 0, output: 'Linux\nv24\nChrome' });
  directory = await mkdtemp(join(tmpdir(), 'mukai-auto-setup-'));
  bundle = join(directory, 'bundle');
  await mkdir(bundle);
  for (const name of ['guest.cjs', 'package.json', 'install.sh', 'mukai-guest.service'])
    await writeFile(join(bundle, name), 'fixture');
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
      if (args.includes('-smbios')) onOutput?.('installer failed\nMUKAI_IMAGE_FAILED\n');
      return { code: 0, output: '' };
    });
    const setup = await service();
    await setup.start();
    await vi.waitFor(async () => expect((await setup.status()).phase).toBe('failed'));
    expect((await setup.status()).message).toContain('Setup details');
    expect((await setup.status()).detail).toContain('installer failed');
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
