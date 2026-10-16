import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const manifestSchema = z
  .object({
    version: z.string(),
    files: z
      .array(
        z
          .object({
            url: z.string(),
            sha512: z.string(),
            size: z.number().int().positive().optional(),
          })
          .passthrough(),
      )
      .min(1),
    path: z.string().optional(),
    sha512: z.string().optional(),
  })
  .passthrough();

export const desktopUpdateNames = (version: string) => [
  `Mukai-Setup-${version}-x64.exe.blockmap`,
  ...['x64', 'arm64'].flatMap((arch) => [
    `Mukai-${version}-mac-${arch}.zip`,
    `Mukai-${version}-mac-${arch}.zip.blockmap`,
    `Mukai-${version}-mac-${arch}.dmg.blockmap`,
  ]),
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
];

async function readManifest(directory: string, name: string, version: string, expected: string[]) {
  const manifest = manifestSchema.parse(parse(await readFile(join(directory, name), 'utf8')));
  if (manifest.version !== version) throw new Error(`Wrong updater version: ${name}`);
  const urls = manifest.files.map((file) => file.url).sort();
  if (JSON.stringify(urls) !== JSON.stringify([...expected].sort()))
    throw new Error(`Unexpected updater payloads: ${name}`);
  for (const file of manifest.files) {
    // Exact filenames above also prevent paths and external URLs in the feed.
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(join(directory, file.url))) hash.update(chunk);
    if (hash.digest('base64') !== file.sha512)
      throw new Error(`Invalid updater checksum: ${file.url}`);
    if (file.size !== undefined && (await stat(join(directory, file.url))).size !== file.size)
      throw new Error(`Invalid updater size: ${file.url}`);
  }
  if (manifest.path !== undefined) {
    const legacy = manifest.files.find((file) => file.url === manifest.path);
    if (!legacy || legacy.sha512 !== manifest.sha512)
      throw new Error(`Invalid updater legacy path: ${name}`);
  }
  return manifest;
}

export async function prepareDesktopUpdates(directory: string, version: string) {
  const macPayloads = (arch: string) => [
    `Mukai-${version}-mac-${arch}.zip`,
    `Mukai-${version}-mac-${arch}.dmg`,
  ];
  // macOS runners build separately. Keep their feeds separate during artifact
  // collection, then combine both architectures into the feed MacUpdater reads.
  const intel = await readManifest(directory, 'latest-mac-x64.yml', version, macPayloads('x64'));
  const arm = await readManifest(directory, 'latest-mac-arm64.yml', version, macPayloads('arm64'));
  await readManifest(directory, 'latest.yml', version, [`Mukai-Setup-${version}-x64.exe`]);
  await readManifest(directory, 'latest-linux.yml', version, [
    `Mukai-${version}-linux-x86_64.AppImage`,
  ]);
  await writeFile(
    join(directory, 'latest-mac.yml'),
    stringify({ ...intel, files: [...intel.files, ...arm.files] }),
  );
  await unlink(join(directory, 'latest-mac-x64.yml'));
  await unlink(join(directory, 'latest-mac-arm64.yml'));
}

// Called on each macOS runner before artifacts from the matrix are collected.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arch = process.argv[2];
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Expected a macOS architecture.');
  void rename('release/latest-mac.yml', `release/latest-mac-${arch}.yml`).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
