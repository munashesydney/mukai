import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { cliArchiveName } from './artifacts';
import { execFileSync } from 'node:child_process';

async function main() {
  const manifest = JSON.parse(await readFile('dist/cli/manifest.json', 'utf8')) as {
    version: string;
  };
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/cli-smoke-'));
  const archive = resolve(
    'release',
    cliArchiveName(manifest.version, process.platform, process.arch),
  );
  try {
    if (process.platform === 'win32')
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:MUKAI_ARCHIVE, $env:MUKAI_STAGE)',
        ],
        { env: { ...process.env, MUKAI_ARCHIVE: archive, MUKAI_STAGE: directory } },
      );
    else execFileSync('tar', ['-xzf', archive, '-C', directory]);
    const root = join(directory, 'mukai');
    const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const entry = join(root, 'app/cli.cjs');
    assert.equal(
      execFileSync(node, [entry, '--version'], { cwd: directory, encoding: 'utf8' }).trim(),
      manifest.version,
    );
    const data = join(directory, 'data');
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const child = spawn(node, [entry, 'serve', '--port', '0', '--data-dir', data], {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let output = '';
    child.stdout!.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.stderr!.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    let state: { url: string; connectionUrl: string } | undefined;
    try {
      // Allow slower cold starts on hosted runners without retrying failed processes.
      const startupTimeout = 60000;
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        try {
          state = JSON.parse(await readFile(join(data, 'cli-server.json'), 'utf8')) as typeof state;
          if (state) break;
        } catch {
          /* Wait for startup. */
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `CLI exited before startup (code: ${child.exitCode}, signal: ${child.signalCode}).\n${output || 'No CLI output was captured.'}`,
          );
        await setTimeout(100);
      }
      assert.ok(
        state,
        `CLI did not create ${join(data, 'cli-server.json')} within ${startupTimeout}ms (pid: ${child.pid}).\n${output || 'No CLI output was captured.'}`,
      );
      assert.equal((await fetch(state.url)).status, 200);
      const proof = await fetch(state.url + '/api/auth/verify', {
        method: 'POST',
        headers: { Origin: state.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: new URLSearchParams(new URL(state.connectionUrl).hash.slice(1)).get('mukai-setup'),
        }),
      });
      assert.equal(proof.status, 200);
      const session = await fetch(state.url + '/api/auth/setup', {
        method: 'POST',
        headers: {
          Origin: state.url,
          'Content-Type': 'application/json',
          Cookie: proof.headers.get('set-cookie')!.split(';')[0],
        },
        body: JSON.stringify({ username: 'smoke-owner', password: 'disposable smoke password' }),
      });
      assert.equal(session.status, 200);
      const cookie = session.headers.get('set-cookie')!.split(';')[0];
      assert.equal(
        (
          await fetch(state.url + '/api/workspaces', {
            headers: { Cookie: cookie, Origin: state.url },
          })
        ).status,
        200,
      );
      const status = execFileSync(node, [entry, 'status', '--data-dir', data], {
        cwd: directory,
        encoding: 'utf8',
      });
      assert.match(status, /is running/);
      assert.match(
        execFileSync(node, [entry, 'doctor', '--data-dir', data], {
          cwd: directory,
          encoding: 'utf8',
        }),
        /OK {2}Computer-use helper/,
      );
      // A private parent IPC channel exercises the same lifecycle as Ctrl+C on every OS.
      child.send({ type: 'mukai:shutdown' });
      assert.equal(
        await Promise.race([
          exited,
          setTimeout(15000).then(() => {
            throw new Error('CLI did not shut down.');
          }),
        ]),
        0,
      );
      assert.match(
        execFileSync(node, [entry, '--help'], { cwd: directory, encoding: 'utf8' }),
        /mukai serve/,
      );
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
    }
    console.log(
      'Packaged CLI smoke passed: isolated runtime, UI, authenticated API, status, shutdown.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
