import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { imageChecksum, downloadImage } from './setupDownload';
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
});

describe('cloud-init seed', () => {
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
