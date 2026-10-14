import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { imageChecksum, downloadImage, downloadVerifiedFile } from './setupDownload';
import { cloudConfig, setupSeed } from './setupSeed';
import { setupProcess } from './setupProcess';
import { guestFiles } from './bundleFiles';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-setup-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('verified setup downloads', () => {
  it('selects only the exact Ubuntu artifact checksum', () => {
    expect(
      imageChecksum('a'.repeat(64) + ' *image.img\n' + 'b'.repeat(64) + '  other.img', 'image.img'),
    ).toBe('a'.repeat(64));
    expect(() => imageChecksum('a'.repeat(64) + ' *fake-image.img', 'image.img')).toThrow(
      'checksum',
    );
  });
  it('streams a verified image into place and reports progress', async () => {
    const bytes = Buffer.from('verified image');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }),
        ),
    );
    const destination = join(directory, 'image.qcow2');
    const progress = vi.fn();
    await downloadImage(
      'https://example.test/image',
      destination,
      createHash('sha256').update(bytes).digest('hex'),
      new AbortController().signal,
      progress,
    );
    expect(await readFile(destination)).toEqual(bytes);
    expect(progress).toHaveBeenCalledWith(bytes.length, bytes.length);
  });
  it('never publishes an image with a mismatched checksum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('damaged image')));
    const destination = join(directory, 'image.qcow2');
    await expect(
      downloadImage(
        'https://example.test/image',
        destination,
        'a'.repeat(64),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('checksum');
    await expect(readFile(destination)).rejects.toThrow();
    await expect(readFile(destination + '.part')).rejects.toThrow();
  });
  it('verifies an installer download before publishing the executable', async () => {
    const bytes = Buffer.from('verified installer');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    const destination = join(directory, 'setup.exe');
    await downloadVerifiedFile(
      'https://example.test/setup',
      destination,
      createHash('sha256').update(bytes).digest('hex'),
      new AbortController().signal,
      vi.fn(),
      { label: 'QEMU installer', maxBytes: 512 * 1024 ** 2 },
    );
    expect(await readFile(destination)).toEqual(bytes);
  });
  it('removes an installer with an incorrect checksum and reports the artifact correctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('damaged installer')));
    const destination = join(directory, 'setup.exe');
    await expect(
      downloadVerifiedFile(
        'https://example.test/setup',
        destination,
        'a'.repeat(64),
        new AbortController().signal,
        vi.fn(),
        { label: 'QEMU installer', maxBytes: 512 * 1024 ** 2 },
      ),
    ).rejects.toThrow('QEMU installer checksum');
    await expect(readFile(destination)).rejects.toThrow();
    await expect(readFile(destination + '.part')).rejects.toThrow();
  });
  it.each([true, false])(
    'bounds installer downloads with content-length=%s',
    async (withLength) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('too large', {
            headers: withLength ? { 'Content-Length': '9' } : {},
          }),
        ),
      );
      const destination = join(directory, 'setup.exe');
      await expect(
        downloadVerifiedFile(
          'https://example.test/setup',
          destination,
          'a'.repeat(64),
          new AbortController().signal,
          vi.fn(),
          { label: 'QEMU installer', maxBytes: 5 },
        ),
      ).rejects.toThrow('QEMU installer exceeds');
      await expect(readFile(destination)).rejects.toThrow();
      await expect(readFile(destination + '.part')).rejects.toThrow();
    },
  );
  it('removes partial installer downloads after cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('installer')));
    const controller = new AbortController();
    const destination = join(directory, 'setup.exe');
    await expect(
      downloadVerifiedFile(
        'https://example.test/setup',
        destination,
        'a'.repeat(64),
        controller.signal,
        () => controller.abort(new Error('Cancelled')),
        { label: 'QEMU installer', maxBytes: 512 },
      ),
    ).rejects.toThrow('Cancelled');
    await expect(readFile(destination)).rejects.toThrow();
    await expect(readFile(destination + '.part')).rejects.toThrow();
  });
});

describe('cloud-init seed', () => {
  it('uses the ARM UART for provisioning logs and disables its login service', () => {
    const config = JSON.parse(cloudConfig({}, 'ttyAMA0').slice('#cloud-config\n'.length));
    expect(config.bootcmd[0]).toContain('serial-getty@ttyAMA0.service');
    expect(config.runcmd[0][2]).toContain('/dev/ttyAMA0');
    expect(config.runcmd[0][2]).not.toContain('/dev/ttyS0');
  });
  it('isolates installer output from the login console and reports its result before shutdown', () => {
    const config = JSON.parse(
      cloudConfig({ 'guest.cjs': Buffer.from('`$(do-not-execute)`') }).slice(
        '#cloud-config\n'.length,
      ),
    );
    expect(Buffer.from(config.write_files[0].content, 'base64').toString()).toBe(
      '`$(do-not-execute)`',
    );
    expect(config.bootcmd).toEqual([['systemctl', 'mask', '--now', 'serial-getty@ttyS0.service']]);
    expect(config.runcmd[0][2]).toContain('sh install.sh > /var/log/mukai-setup.log 2>&1');
    expect(config.runcmd[0][2]).toContain('if wait "$installer"');
    expect(config.runcmd[0][2]).toContain('else result=MUKAI_IMAGE_FAILED; fi;');
    expect(config.runcmd[0][2]).toContain('/etc/cloud/cloud-init.disabled');
  });
  it('serves only token-scoped NoCloud metadata on loopback', async () => {
    const bundle = join(directory, 'bundle');
    await mkdir(bundle);
    for (const name of guestFiles) await writeFile(join(bundle, name), 'fixture');
    const seed = await setupSeed(bundle);
    try {
      const url = `http://127.0.0.1:${seed.port}/`;
      expect((await fetch(url + 'user-data')).status).toBe(404);
      expect((await fetch(url + seed.token + '/../../anything')).status).toBe(404);
      expect(await (await fetch(url + seed.token + '/user-data')).text()).toContain(
        '#cloud-config',
      );
      expect(await (await fetch(url + seed.token + '/meta-data')).json()).toHaveProperty(
        'instance-id',
      );
      expect((await fetch(url + seed.token + '/user-data', { method: 'POST' })).status).toBe(404);
    } finally {
      await seed.close();
    }
  });
});

describe('setup subprocesses', () => {
  it('clears the setup deadline when an executable cannot be found', async () => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(
        setupProcess(join(directory, 'missing.exe'), [], new AbortController().signal),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[0].value);
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
    }
  });
  it('uses bounded output and excludes provider secrets from child environments', async () => {
    vi.stubEnv('MUKAI_TEST_API_KEY', 'should-not-be-inherited');
    const result = await setupProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(String(process.env.MUKAI_TEST_API_KEY));process.stdout.write("x".repeat(14000));',
      ],
      new AbortController().signal,
    );
    expect(result.code).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(12000);
    const secret = await setupProcess(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.MUKAI_TEST_API_KEY))'],
      new AbortController().signal,
    );
    expect(secret.output).toBe('undefined');
  });
  it('terminates setup subprocesses on cancellation', async () => {
    const controller = new AbortController();
    const pending = setupProcess(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      controller.signal,
    );
    const cancelled = expect(pending).rejects.toThrow('interrupted');
    controller.abort();
    await cancelled;
  });
});
