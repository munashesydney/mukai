import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runtimeExecutable } from './installation';
import type { CliArguments } from './arguments';

/** Keep the foreground terminal and signals attached while workers change Node versions. */
export async function supervise(initialRoot: string, options: CliArguments) {
  let child: ChildProcess | undefined;
  let workerReady = false;
  let stopping = false;
  const shutdown = () => {
    stopping = true;
    if (workerReady && child?.connected) child.send({ type: 'mukai:shutdown' }, () => {});
  };
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'mukai:shutdown'
    )
      shutdown();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('disconnect', shutdown);
  if (process.send) process.on('message', onMessage);
  let root = initialRoot;
  let port = options.port;
  let open = options.open;
  try {
    while (!stopping) {
      let next: { root: string; port: number } | undefined;
      workerReady = false;
      const args = [
        join(root, 'app/cli.cjs'),
        'serve',
        '--port',
        String(port),
        '--data-dir',
        options.dataDir,
        ...(open ? ['--open'] : []),
      ];
      child = spawn(runtimeExecutable(root), args, {
        env: { ...process.env, MUKAI_CLI_WORKER: '1' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      });
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.type === 'mukai:ready') {
          workerReady = true;
          if (stopping) shutdown();
        }
        if (
          value.type === 'mukai:restart' &&
          typeof value.root === 'string' &&
          Number.isInteger(value.port) &&
          Number(value.port) > 0 &&
          Number(value.port) <= 65535
        ) {
          // Only private IPC from our own worker can select a replacement runtime.
          next = { root: resolve(value.root), port: Number(value.port) };
        }
      });
      const code = await new Promise<number>((done, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 1)));
      });
      child = undefined;
      if (!next || stopping || code !== 0) return code;
      root = next.root;
      port = next.port;
      open = false;
    }
    return 0;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    process.off('disconnect', shutdown);
    process.off('message', onMessage);
  }
}
