import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installerNames, publishInstallers, releaseNotes, verifyInstallers } from './release';
import { parse, stringify } from 'yaml';
import { desktopUpdateNames } from './desktop-updates';
import { writeDesktopRelease } from './fixtures/desktop-release';

const version = '0.1.0-build.12.1';
const options = {
  repository: 'owner/mukai',
  version,
  sha: 'abc',
  files: ['installer.exe'],
  notes: 'notes.md',
};

test('release notes distinguish notarized Macs from unsigned Windows and PR builds', () => {
  const signed = releaseNotes('abc', true);
  assert.match(signed, /mukai-release:macos-notarized/);
  assert.match(signed, /Windows does not have a verified publisher signature/);
  assert.doesNotMatch(signed, /may require approval in Privacy/);
  const unsigned = releaseNotes('abc', false);
  assert.doesNotMatch(unsigned, /mukai-release:macos-notarized/);
  assert.match(unsigned, /without Apple notarization/);
});

test('missing, extra, or empty installers cannot be published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-release-'));
  try {
    await assert.rejects(verifyInstallers(directory, version, 1), /exactly/);
    await writeDesktopRelease(directory, version);
    await writeFile(join(directory, installerNames(version)[0]), '');
    await assert.rejects(verifyInstallers(directory, version, 1), /Invalid updater checksum/);
    await writeFile(join(directory, installerNames(version)[0]), 'installer');
    const files = await verifyInstallers(directory, version, 1);
    assert.equal(
      files.length,
      installerNames(version).length + desktopUpdateNames(version).length + 1,
    );
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
    assert.equal(sums.trim().split('\n').length, files.length - 1);
    assert.match(sums, /^[a-f0-9]{64}\s{2}Mukai-Setup-/);
    const mac = parse(await readFile(join(directory, 'latest-mac.yml'), 'utf8'));
    assert.equal(mac.files.length, 4);
    assert.ok(mac.files.some((file: { url: string }) => file.url.endsWith('arm64.zip')));
    await assert.rejects(verifyInstallers(directory, version, 1), /exactly/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid, stale, or external updater payloads block publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-release-'));
  try {
    for (const change of [
      (manifest: Record<string, unknown>) => {
        manifest.version = '0.1.0-build.1.1';
      },
      (manifest: Record<string, unknown>) => {
        manifest.files = [{ url: 'https://example.com/update.exe', sha512: 'x' }];
      },
      (manifest: Record<string, unknown>) => {
        manifest.files = [{ url: installerNames(version)[0], sha512: 'x' }];
      },
    ]) {
      await writeDesktopRelease(directory, version);
      const path = join(directory, 'latest.yml');
      const manifest = parse(await readFile(path, 'utf8'));
      change(manifest);
      await writeFile(path, stringify(manifest));
      await assert.rejects(verifyInstallers(directory, version, 1), /updater/);
      await assert.rejects(readFile(join(directory, 'SHA256SUMS.txt')));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('superseded builds do not create releases', () => {
  const calls: string[][] = [];
  assert.equal(
    publishInstallers((args) => {
      calls.push(args);
      return 'newer';
    }, options),
    false,
  );
  assert.equal(calls.length, 1);
});

test('failed uploads leave a draft instead of replacing latest', () => {
  const calls: string[][] = [];
  assert.throws(
    () =>
      publishInstallers((args) => {
        calls.push(args);
        if (args[1] === 'upload') throw new Error('Upload failed');
        return 'abc';
      }, options),
    /Upload failed/,
  );
  assert.ok(calls[1].includes('--draft'));
  assert.ok(!calls.some((args) => args[1] === 'edit'));
});

test('all assets are uploaded before a release becomes latest', () => {
  const calls: string[][] = [];
  assert.equal(
    publishInstallers((args) => {
      calls.push(args);
      return 'abc';
    }, options),
    true,
  );
  assert.deepEqual(
    calls.map((args) => args[1]),
    ['repos/owner/mukai/commits/main', 'create', 'upload', 'edit'],
  );
  assert.ok(calls[3].includes('--draft=false'));
  assert.ok(calls[3].includes('--latest'));
});
