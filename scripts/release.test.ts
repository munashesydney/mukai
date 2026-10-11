import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installerNames, publishInstallers, verifyInstallers } from './release';

const version = '0.1.0-build.12.1';
const options = {
  repository: 'owner/mukai',
  version,
  sha: 'abc',
  files: ['installer.exe'],
  notes: 'notes.md',
};

test('missing, extra, or empty installers cannot be published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-release-'));
  try {
    await assert.rejects(verifyInstallers(directory, version, 1), /exactly/);
    for (const name of installerNames(version)) await writeFile(join(directory, name), 'installer');
    await writeFile(join(directory, installerNames(version)[0]), '');
    await assert.rejects(verifyInstallers(directory, version, 1), /Invalid installer/);
    await writeFile(join(directory, installerNames(version)[0]), 'installer');
    const files = await verifyInstallers(directory, version, 1);
    assert.equal(files.length, 5);
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
    assert.equal(sums.trim().split('\n').length, 4);
    assert.match(sums, /^[a-f0-9]{64}\s{2}Mukai-Setup-/);
    await assert.rejects(verifyInstallers(directory, version, 1), /exactly/);
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
