import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  activeInstallation,
  activateUpdate,
  compareVersions,
  findInstallation,
  latestRelease,
  prepareUpdate,
  runtimeExecutable,
  type Installation,
  type CliRelease,
} from './installation';
import { acquireDataLock } from '../server/config';

describe('CLI version ordering', () => {
  it('compares numeric release builds and stable versions without downgrades', () => {
    for (const [a, b] of [
      ['0.1.0-build.10.1', '0.1.0-build.9.2'],
      ['1.10.0', '1.9.0'],
      ['1.0.0', '1.0.0-build.99'],
      ['1.0.0-beta', '1.0.0-1'],
    ]) {
      expect(compareVersions(a, b)).toBe(1);
      expect(compareVersions(b, a)).toBe(-1);
    }
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareVersions('../../unsafe', '1.0.0')).toThrow();
  });
});

describe('CLI installation updates', () => {
  let directory: string;
  let archive: Buffer;
  let release: CliRelease;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mukai-update-'));
    const source = join(directory, 'source/mukai');
    for (const folder of ['runtime', 'app', 'web'])
      await mkdir(join(source, folder), { recursive: true });
    // Hard-link the real Node binary so verification exercises a real replacement runtime.
    await link(process.execPath, runtimeExecutable(source)).catch(() =>
      copyFile(process.execPath, runtimeExecutable(source)),
    );
    await writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({
        product: 'mukai-cli',
        version: '0.1.0-build.10.1',
        platform: process.platform,
        arch: process.arch,
      }),
    );
    await writeFile(join(source, 'app/cli.cjs'), 'console.log("0.1.0-build.10.1");');
    await writeFile(join(source, 'web/index.html'), 'new UI');
    const file = join(directory, 'fixture.tar');
    execFileSync('tar', ['-cf', file, '-C', join(directory, 'source'), 'mukai']);
    archive = await readFile(file);
    release = {
      version: '0.1.0-build.10.1',
      platform: process.platform,
      arch: process.arch,
      file: `mukai-cli-0.1.0-build.10.1-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
  }, 30000);
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function fixture(platform = process.platform) {
    const directory = await mkdtemp(join(tmpdir(), 'mukai-managed-'));
    const host: Installation = { directory, platform, arch: process.arch };
    const oldRoot = join(directory, 'versions/old/mukai');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'manifest.json'), JSON.stringify({ version: '0.1.0-build.9.1' }));
    if (platform === 'win32') {
      await mkdir(join(directory, 'bin'));
      await writeFile(
        join(directory, 'bin/mukai.cmd'),
        '@echo off\r\nrem Mukai CLI launcher\r\n"%~dp0..\\versions\\old\\mukai\\runtime\\node.exe" %*\r\n',
      );
    } else await writeFile(join(directory, 'active-version'), 'old\n');
    return { host, oldRoot, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }
  const download: typeof fetch = async () =>
    new Response(new Uint8Array(archive), {
      headers: { 'Content-Length': String(archive.length) },
    });
  it('selects only a fixed platform artifact from the official manifest', async () => {
    const host = { directory, platform: process.platform, arch: process.arch };
    const manifest = { schemaVersion: 1, version: release.version, artifacts: [release] };
    const request: typeof fetch = async (input) => {
      expect(String(input)).toBe(
        'https://github.com/munashesydney/mukai/releases/latest/download/cli-manifest.json',
      );
      return Response.json(manifest);
    };
    expect(await latestRelease(host, request)).toEqual(release);
    manifest.artifacts = [{ ...release, file: '../../evil' }];
    await expect(latestRelease(host, request)).rejects.toThrow('no CLI download');
    manifest.artifacts = [release, release];
    await expect(latestRelease(host, request)).rejects.toThrow('no CLI download');
  });
  it('stages and verifies a real runtime before activating, retaining the old version', async () => {
    const { host, oldRoot, cleanup } = await fixture();
    try {
      expect(await findInstallation(oldRoot)).toEqual(host);
      const percents: number[] = [];
      const prepared = await prepareUpdate(host, release, (p) => percents.push(p), download);
      expect(await activeInstallation(host)).toBe(oldRoot);
      expect(percents.at(-1)).toBe(100);
      expect(await readFile(join(prepared.root, 'web/index.html'), 'utf8')).toBe('new UI');
      expect(await activateUpdate(host, prepared)).toBe(prepared.root);
      expect(await activeInstallation(host)).toBe(prepared.root);
      expect(await stat(oldRoot)).toBeTruthy();
      expect((await readdir(host.directory)).some((n) => n.startsWith('staging-update-'))).toBe(
        false,
      );
    } finally {
      await cleanup();
    }
  }, 30000);
  it('rejects corrupt downloads and releases the lock for a retry', async () => {
    const { host, oldRoot, cleanup } = await fixture();
    try {
      await expect(
        prepareUpdate(
          host,
          { ...release, sha256: '0'.repeat(64) },
          () => {},
          async () => new Response('corrupt'),
        ),
      ).rejects.toThrow('checksum');
      expect(await activeInstallation(host)).toBe(oldRoot);
      expect((await readdir(host.directory)).some((n) => n.startsWith('staging-update-'))).toBe(
        false,
      );
      const unlock = acquireDataLock(join(host.directory, '.update-lock'));
      unlock();
    } finally {
      await cleanup();
    }
  });
  it('rejects overlapping updates without changing the launcher', async () => {
    const { host, oldRoot, cleanup } = await fixture();
    const unlock = acquireDataLock(join(host.directory, '.update-lock'));
    try {
      await expect(prepareUpdate(host, release, () => {}, download)).rejects.toThrow(
        'Another CLI update',
      );
      expect(await activeInstallation(host)).toBe(oldRoot);
    } finally {
      unlock();
      await cleanup();
    }
  });
  it.each(['win32', 'linux', 'darwin'] as const)(
    'atomically switches %s launchers without downgrading a newer active version',
    async (platform) => {
      const { host, cleanup } = await fixture(platform);
      try {
        const root = join(host.directory, 'versions/new/mukai');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: release.version }));
        const prepared = { version: release.version, root, installation: 'new' };
        expect(await activateUpdate(host, prepared)).toBe(root);
        expect(await activeInstallation(host)).toBe(root);
        expect(await activateUpdate(host, { ...prepared, version: '0.1.0-build.1.1' })).toBe(root);
        await expect(
          activateUpdate(host, { ...prepared, root: join(host.directory, '..') }),
        ).rejects.toThrow('Invalid staged');
      } finally {
        await cleanup();
      }
    },
  );
  it('leaves checkouts and portable directories unmanaged', async () => {
    expect(await findInstallation(directory)).toBeUndefined();
    expect(await findInstallation(join(directory, 'source/mukai'))).toBeUndefined();
  });
});
