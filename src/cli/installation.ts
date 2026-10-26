import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { acquireDataLock } from '../server/config';

const run = promisify(execFile);
const releases = 'https://github.com/munashesydney/mukai/releases';
const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  .max(100);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: versionSchema,
  artifacts: z.array(
    z.object({
      platform: z.string(),
      arch: z.string(),
      file: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

/** Release build suffixes use numeric identifiers (build.9 sorts before build.10). */
export function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    versionSchema.parse(value);
    const [core, ...suffix] = value.split('-');
    return { core: core.split('.').map(BigInt), pre: suffix.join('-').split('.') };
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre[0] || !b.pre[0]) return Number(!a.pre[0]) - Number(!b.pre[0]);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else return x > y ? 1 : -1;
  }
  return 0;
}

export interface Installation {
  directory: string;
  platform: NodeJS.Platform;
  arch: string;
}
export interface PreparedUpdate {
  version: string;
  root: string;
  installation: string;
}
export const runtimeExecutable = (root: string, platform = process.platform) =>
  join(root, 'runtime', platform === 'win32' ? 'node.exe' : 'node');

const validInstallation = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name);

export async function activeInstallation(host: Installation) {
  const name =
    host.platform === 'win32'
      ? (await readFile(join(host.directory, 'bin/mukai.cmd'), 'utf8')).match(
          /versions\\([^\\\r\n"]+)\\mukai\\/,
        )?.[1]
      : (await readFile(join(host.directory, 'active-version'), 'utf8')).trim();
  if (!name || !validInstallation(name))
    throw new Error('Invalid CLI installation pointer. Re-run the installer.');
  return join(host.directory, 'versions', name, 'mukai');
}

export async function findInstallation(root: string): Promise<Installation | undefined> {
  // Only installer-managed layouts can be updated; never overwrite a checkout or portable archive.
  if (basename(root) !== 'mukai' || basename(dirname(dirname(root))) !== 'versions') return;
  const directory = dirname(dirname(dirname(root)));
  const host = { directory, platform: process.platform, arch: process.arch };
  try {
    if (
      host.platform === 'win32' &&
      !(await readFile(join(directory, 'bin/mukai.cmd'), 'utf8')).includes('rem Mukai CLI launcher')
    )
      return;
    await activeInstallation(host);
    return host;
  } catch {
    return;
  }
}

function lock(host: Installation) {
  try {
    return acquireDataLock(join(host.directory, '.update-lock'));
  } catch (error) {
    throw new Error('Another CLI update is in progress, or the installation is not writable.', {
      cause: error,
    });
  }
}

export async function latestRelease(host: Installation, request = fetch) {
  const response = await request(`${releases}/latest/download/cli-manifest.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error('Could not obtain the latest CLI release. Check your connection and retry.');
  const manifest = manifestSchema.parse(await response.json());
  const extension = host.platform === 'win32' ? 'zip' : 'tar.gz';
  const file = `mukai-cli-${manifest.version}-${host.platform}-${host.arch}.${extension}`;
  const artifacts = manifest.artifacts.filter(
    (a) => a.platform === host.platform && a.arch === host.arch,
  );
  if (artifacts.length !== 1 || artifacts[0].file !== file)
    throw new Error('This release has no CLI download for your platform.');
  return { version: manifest.version, ...artifacts[0] };
}
export type CliRelease = Awaited<ReturnType<typeof latestRelease>>;

export async function prepareUpdate(
  host: Installation,
  release: CliRelease,
  progress: (percent: number) => void,
  request = fetch,
  signal?: AbortSignal,
): Promise<PreparedUpdate> {
  const unlock = lock(host);
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(host.directory, 'staging-update-'));
    const archive = join(stage, 'download');
    const response = await request(`${releases}/download/v${release.version}/${release.file}`, {
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok || !response.body) throw new Error('Could not download the CLI update.');
    const total = Number(response.headers.get('content-length'));
    let received = 0;
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    async function* chunks() {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(
      Readable.from(chunks()),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > 2 * 1024 ** 3)
            return callback(new Error('CLI download exceeds the size limit.'));
          hash.update(chunk);
          progress(total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0);
          callback(null, chunk);
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (hash.digest('hex') !== release.sha256)
      throw new Error('CLI download checksum does not match. Retry the download.');
    // The same OS archive utility used by the installers handles long Windows paths.
    const tar =
      host.platform === 'win32'
        ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe')
        : 'tar';
    await run(tar, ['-xf', archive, '-C', stage], {
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      signal,
    });
    const unpacked = join(stage, 'mukai');
    const manifest = JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      manifest.product !== 'mukai-cli' ||
      manifest.version !== release.version ||
      manifest.platform !== host.platform ||
      manifest.arch !== host.arch
    )
      throw new Error('Downloaded CLI has the wrong version or platform.');
    for (const file of ['app/cli.cjs', 'web/index.html']) await readFile(join(unpacked, file));
    const { stdout } = await run(
      runtimeExecutable(unpacked, host.platform),
      [join(unpacked, 'app/cli.cjs'), '--version'],
      {
        timeout: 30000,
        windowsHide: true,
        signal,
      },
    );
    if (stdout.trim() !== release.version)
      throw new Error('Downloaded CLI failed its runtime check.');
    const installation = `${release.version}-update-${randomUUID()}`;
    signal?.throwIfAborted();
    const target = join(host.directory, 'versions', installation);
    await mkdir(join(stage, 'version'));
    await rename(unpacked, join(stage, 'version/mukai'));
    await mkdir(join(host.directory, 'versions'), { recursive: true });
    await rename(join(stage, 'version'), target);
    progress(100);
    return { version: release.version, root: join(target, 'mukai'), installation };
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      unlock();
    }
  }
}

/** Switch a small pointer atomically; installed/running files and user data stay intact. */
export async function activateUpdate(host: Installation, update: PreparedUpdate) {
  const unlock = lock(host);
  let temporary: string | undefined;
  try {
    if (
      !validInstallation(update.installation) ||
      resolve(update.root) !== resolve(host.directory, 'versions', update.installation, 'mukai')
    )
      throw new Error('Invalid staged update path.');
    const active = await activeInstallation(host);
    const current = JSON.parse(await readFile(join(active, 'manifest.json'), 'utf8')) as {
      version: string;
    };
    // A different terminal may already have installed a newer version.
    if (compareVersions(current.version, update.version) >= 0) return active;
    const pointer =
      host.platform === 'win32'
        ? join(host.directory, 'bin/mukai.cmd')
        : join(host.directory, 'active-version');
    const text =
      host.platform === 'win32'
        ? `@echo off\r\nrem Mukai CLI launcher\r\n"%~dp0..\\versions\\${update.installation}\\mukai\\runtime\\node.exe" "%~dp0..\\versions\\${update.installation}\\mukai\\app\\cli.cjs" %*\r\nexit /b %errorlevel%\r\n`
        : update.installation + '\n';
    temporary = pointer + '.' + randomUUID();
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, pointer);
    return update.root;
  } finally {
    try {
      if (temporary) await rm(temporary, { force: true });
    } finally {
      unlock();
    }
  }
}
