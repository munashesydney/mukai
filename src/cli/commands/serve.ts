import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startApiServer } from '../../server/app';
import type { CliArguments } from '../arguments';
import { runtimePaths, version } from '../runtime';
import { removeServerState, writeServerState } from '../serverState';
import { findInstallation } from '../installation';
import { CliUpdater } from '../updater';

export async function openBrowser(url: string) {
  const command =
    process.platform === 'win32'
      ? 'rundll32.exe'
      : process.platform === 'darwin'
        ? '/usr/bin/open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('Browser could not open. Use the printed connection link.')),
    );
  });
}

export async function serve(options: CliArguments) {
  const paths = runtimePaths();
  if (!existsSync(join(paths.webDir, 'index.html')))
    throw new Error(
      'Mukai UI is missing. In a checkout, run npm run build:cli. For an installation, reinstall Mukai CLI.',
    );
  const installation =
    process.send && process.env.MUKAI_CLI_WORKER === '1'
      ? await findInstallation(paths.root)
      : undefined;
  const updater = new CliUpdater(version(), installation, {
    saveAutomaticUpdates: (enabled) => {
      api.settings.saveAutomaticUpdates(enabled);
    },
    restart: async (root) => {
      if (!process.send || stopping)
        throw new Error('The CLI server is stopping. Restart it from your terminal.');
      // Preserve the actual bound port, including when serve was launched with --port 0.
      await new Promise<void>((done, reject) =>
        process.send!(
          {
            type: 'mukai:restart',
            root,
            port: Number(new URL(api.url).port),
          },
          (error) => (error ? reject(error) : done()),
        ),
      );
      await stop();
    },
  });
  const api = await startApiServer(options.port, {
    ...paths,
    dataDir: options.dataDir,
    version: version(),
    updates: updater,
  });
  const session = api.browserSession!;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('message', onMessage);
      process.off('disconnect', onSignal);
      await updater.shutdown();
      // Stop accepting requests before waiting for tools and schedulers to settle.
      const closed = new Promise<void>((resolve, reject) =>
        api.server.close((error) => (error ? reject(error) : resolve())),
      );
      await api.shutdown();
      api.server.closeAllConnections();
      await closed;
      await removeServerState(options.dataDir, session.instanceId);
    })());
  const onSignal = () => {
    void stop().catch((error) => {
      console.error('Shutdown failed:', error instanceof Error ? error.message : 'Unknown error');
      process.exitCode = 1;
    });
  };
  const onMessage = (message: unknown) => {
    if (
      process.send &&
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'mukai:shutdown'
    )
      onSignal();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.send) {
    process.on('message', onMessage);
    process.once('disconnect', onSignal);
  }
  updater.initialize(api.settings.automaticUpdates());
  const connectionUrl = api.ownerAuth!.configured()
    ? `${api.url}/`
    : `${api.url}/#mukai-setup=${api.ownerAuth!.setupCode}`;
  try {
    await writeServerState(options.dataDir, {
      pid: process.pid,
      instanceId: session.instanceId,
      version: version(),
      url: api.url,
      connectionUrl,
    });
  } catch (error) {
    await stop();
    throw error;
  }
  if (process.connected) process.send?.({ type: 'mukai:ready' });
  console.log(
    `Mukai ${version()}\nLocal address: ${api.url}\nConnect: ${connectionUrl}\nData: ${options.dataDir}\nPress Ctrl+C to stop.`,
  );
  if (!api.ownerAuth!.configured())
    console.log(
      `Setup code: ${api.ownerAuth!.setupCode.match(/.{1,8}/g)!.join('-')}\nThis code expires in 30 minutes. Keep it private.`,
    );
  if (options.open)
    await openBrowser(connectionUrl).catch(() =>
      console.error('Could not open your browser. Open the connection link above.'),
    );
  return { ...api, connectionUrl, stop };
}
