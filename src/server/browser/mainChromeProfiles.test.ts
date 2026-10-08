import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { MainChromeProfiles } from './mainChromeProfiles';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mukai-profile-discovery-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function metadata(cache: Record<string, unknown>) {
  await writeFile(
    join(directory, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Profile 1', info_cache: cache } }),
  );
}
it('discovers existing named profiles without exposing unrelated account metadata or stale/hidden entries', async () => {
  for (const id of ['Default', 'Profile 1', 'Guest Profile', 'Hidden', 'Temporary'])
    await mkdir(join(directory, id));
  await metadata({
    Default: { name: 'Personal', user_name: 'private@example.com' },
    'Profile 1': { name: 'Work' },
    'Guest Profile': { name: 'Guest' },
    Hidden: { name: 'Hidden', is_omitted: true },
    Temporary: { name: 'Temporary', is_ephemeral: true },
    Missing: { name: 'Deleted' },
    '../outside': { name: 'Invalid' },
  });
  expect(await new MainChromeProfiles(directory).list()).toEqual([
    { id: 'Default', name: 'Personal', lastUsed: false },
    { id: 'Profile 1', name: 'Work', lastUsed: true },
  ]);
});
it('handles Chrome not initialized and rejects unknown IDs and corrupt metadata without substituting profiles', async () => {
  const profiles = new MainChromeProfiles(directory);
  expect(await profiles.list()).toEqual([]);
  await expect(profiles.require('../outside')).rejects.toThrow('not found');
  await writeFile(join(directory, 'Local State'), 'not JSON');
  await expect(profiles.list()).rejects.toThrow('metadata could not be read');
});
it('verifies the actual profile path and rejects another profile or another Chrome data directory', async () => {
  await mkdir(join(directory, 'Default'));
  await mkdir(join(directory, 'Profile 1'));
  await metadata({ Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } });
  const profiles = new MainChromeProfiles(directory);
  const text = vi.fn().mockResolvedValue(join(directory, 'Profile 1'));
  const page = { goto: vi.fn(), locator: vi.fn(() => ({ innerText: text })) } as unknown as Page;
  const work = await profiles.require('Profile 1');
  expect(await profiles.identify(page, work)).toEqual(work);
  text.mockResolvedValue(join(directory, 'Default'));
  await expect(profiles.identify(page, work)).rejects.toThrow('different profile');
  text.mockResolvedValue(directory);
  await expect(profiles.identify(page, work)).rejects.toThrow('different profile');
});
