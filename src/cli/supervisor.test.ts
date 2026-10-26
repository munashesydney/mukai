import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runtimeExecutable } from './installation';

describe('foreground CLI supervisor', () => {
  it('waits for the old worker to exit, preserves its bound port and data directory, and forwards shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukai-supervisor-'));
    const oldRoot = join(directory, 'old'),
      newRoot = join(directory, 'new');
    const dataDir = join(directory, 'user data');
    await mkdir(dataDir);
    for (const root of [oldRoot, newRoot]) {
      await mkdir(join(root, 'app'), { recursive: true });
      await mkdir(join(root, 'runtime'));
      await link(process.execPath, runtimeExecutable(root)).catch(() =>
        copyFile(process.execPath, runtimeExecutable(root)),
      );
      await writeFile(
        join(root, 'app/cli.cjs'),
        `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
const data = args[args.indexOf('--data-dir') + 1];
const lock = path.join(data, 'server.lock');
fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
const server = http.createServer((req, res) => res.end(${JSON.stringify(root === oldRoot ? 'old' : 'new')}));
server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(data, ${JSON.stringify(root === oldRoot ? 'old.json' : 'new.json')}), JSON.stringify({ args, port, pid: process.pid }));
  process.send({ type: 'mukai:ready' });
  ${
    root === oldRoot
      ? `process.send({ type: 'mukai:restart', root: ${JSON.stringify(newRoot)}, port }, () => {
    server.close(() => { fs.unlinkSync(lock); process.exit(0); });
  });`
      : ''
  }
});
process.on('message', message => {
  if (message.type === 'mukai:shutdown') server.close(() => { fs.unlinkSync(lock); process.exit(0); });
});
`,
      );
    }
    const parentEntry = join(directory, 'parent.cjs');
    await build({
      stdin: {
        contents: `import { supervise } from './src/cli/supervisor';
supervise(process.argv[2], { command: 'serve', port: 0, open: true, dataDir: process.argv[3] })
  .then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });`,
        resolveDir: resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: parentEntry,
    });
    const parent = spawn(process.execPath, [parentEntry, oldRoot, dataDir], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let output = '';
    parent.stderr!.on('data', (bytes) => {
      output += String(bytes);
    });
    const exited = new Promise<number | null>((done, reject) => {
      parent.once('error', reject);
      parent.once('exit', done);
    });
    try {
      let replacement: { args: string[]; port: number; pid: number } | undefined;
      for (let i = 0; i < 100; i++) {
        try {
          replacement = JSON.parse(await readFile(join(dataDir, 'new.json'), 'utf8'));
          break;
        } catch {
          /* Wait for the replacement to bind the released port. */
        }
        if (parent.exitCode !== null)
          throw new Error(output || 'Supervisor exited before replacement startup.');
        await setTimeout(50);
      }
      expect(replacement, output).toBeDefined();
      const original = JSON.parse(await readFile(join(dataDir, 'old.json'), 'utf8')) as {
        port: number;
        args: string[];
      };
      expect(replacement!.port).toBe(original.port);
      expect(original.args).toContain('--open');
      expect(replacement!.args).not.toContain('--open');
      expect(replacement!.args).toContain(dataDir);
      expect(await (await fetch(`http://127.0.0.1:${replacement!.port}`)).text()).toBe('new');
      parent.send({ type: 'mukai:shutdown' });
      expect(await Promise.race([exited, setTimeout(5000).then(() => 'timeout')])).toBe(0);
      await expect(readFile(join(dataDir, 'server.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (parent.exitCode === null) {
        parent.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
});
