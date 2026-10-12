import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const installerNames = (version: string) => [
  `Mukai-Setup-${version}-x64.exe`,
  `Mukai-${version}-mac-x64.dmg`,
  `Mukai-${version}-mac-arm64.dmg`,
  `Mukai-${version}-linux-x86_64.AppImage`,
];

export async function verifyInstallers(
  directory: string,
  version: string,
  minimumBytes = 1024 * 1024,
) {
  if (!/^\d+\.\d+\.\d+-build\.\d+\.\d+$/.test(version)) throw new Error('Invalid build version.');
  const names = installerNames(version);
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort()))
    throw new Error('Release must contain exactly the four expected installers.');
  const sums: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size < minimumBytes) throw new Error(`Invalid installer: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  return [...names, 'SHA256SUMS.txt'].map((name) => join(directory, name));
}

type Github = (args: string[]) => string;
export function releaseNotes(sha: string, macosNotarized: boolean) {
  return `<!-- mukai-release:unsigned -->\n${macosNotarized ? '<!-- mukai-release:macos-notarized -->\n' : ''}Desktop installers built from commit ${sha}.\n\n- Windows x64: setup wizard\n- macOS: separate Intel and Apple Silicon disk images\n- Linux x64: AppImage\n\nWindows does not have a verified publisher signature yet and may show a publisher warning. ${macosNotarized ? 'macOS applications are signed with Developer ID, notarized by Apple, and include a stapled notarization ticket.' : 'macOS builds use local ad-hoc signing without Apple notarization and may require approval in Privacy & Security.'}\n\nSHA256SUMS.txt contains checksums for each installer.\n`;
}
export function publishInstallers(
  github: Github,
  {
    repository,
    version,
    sha,
    files,
    notes,
  }: { repository: string; version: string; sha: string; files: string[]; notes: string },
) {
  const current = github(['api', `repos/${repository}/commits/main`, '--jq', '.sha']).trim();
  if (current !== sha) return false; // A newer push must not be replaced by this older build.
  const tag = `v${version}`;
  github([
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--target',
    sha,
    '--draft',
    '--title',
    `Mukai ${version}`,
    '--notes-file',
    notes,
  ]);
  github(['release', 'upload', tag, ...files, '--repo', repository]);
  // Drafts are invisible to the website; publish only after every asset is uploaded.
  github(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  return true;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const version = process.env.RELEASE_VERSION;
  const sha = process.env.GITHUB_SHA;
  if (!repository || !version || !sha) throw new Error('GitHub release environment is required.');
  const directory = resolve(process.argv[2] || 'release-artifacts');
  const files = await verifyInstallers(directory, version);
  const notes = join(directory, 'release-notes.md');
  await writeFile(notes, releaseNotes(sha, process.env.MACOS_NOTARIZED === 'true'));
  const github: Github = (args) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(
    publishInstallers(github, { repository, version, sha, files, notes })
      ? `Published ${version}.`
      : 'Skipped superseded main commit.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
