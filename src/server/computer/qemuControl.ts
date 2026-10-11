import { createServer, type Socket } from 'node:net';
import { Frames, encodeFrame } from './protocol';

/** Private QMP connection established before the guest boots. Stop listening once QEMU connects. */
export async function qemuControl(onEvent?: (event: string, reason?: string) => void) {
  let connection: Socket | undefined;
  let ready = false;
  let sequence = 0;
  const queries = new Map<string, (value?: unknown, error?: Error) => void>();
  const server = createServer((socket) => {
    if (connection) {
      socket.destroy();
      return;
    }
    connection = socket;
    server.close();
    const frames = new Frames();
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      ready = false;
      for (const finish of queries.values()) finish();
      queries.clear();
    });
    socket.on('data', (bytes) => {
      try {
        for (const frame of frames.push(bytes)) {
          if (!frame || typeof frame !== 'object') throw new Error('Invalid QMP frame.');
          if ('QMP' in frame)
            socket.write(encodeFrame({ execute: 'qmp_capabilities', id: 'capabilities' }));
          else if ('id' in frame && frame.id === 'capabilities' && 'return' in frame) ready = true;
          else if ('id' in frame && typeof frame.id === 'string' && queries.has(frame.id)) {
            const error =
              'error' in frame
                ? new Error('QEMU command failed: ' + JSON.stringify(frame.error).slice(0, 512))
                : undefined;
            queries.get(frame.id)?.('return' in frame ? frame.return : undefined, error);
          } else if (
            'event' in frame &&
            typeof frame.event === 'string' &&
            /^(SHUTDOWN|STOP|RESUME|RESET|SUSPEND|WAKEUP|GUEST_PANICKED)$/.test(frame.event)
          ) {
            const data =
              'data' in frame && frame.data && typeof frame.data === 'object'
                ? frame.data
                : undefined;
            const reason =
              data && 'reason' in data && typeof data.reason === 'string'
                ? data.reason.slice(0, 128)
                : undefined;
            onEvent?.(frame.event, reason);
          }
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not open QEMU control socket.');
  }
  const command = (
    execute: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    if (!ready || !connection || connection.destroyed)
      return Promise.reject(new Error('QEMU control is unavailable.'));
    if (queries.size >= 4) return Promise.reject(new Error('QEMU control is busy.'));
    const socket = connection;
    const id = `query-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new Error('QEMU command timed out.')), 5000);
      const abort = () => finish(undefined, new Error('QEMU command cancelled.'));
      const finish = (value?: unknown, error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        queries.delete(id);
        if (error) reject(error);
        else if (value === undefined) reject(new Error('QEMU control disconnected.'));
        else resolve(value);
      };
      queries.set(id, finish);
      signal?.addEventListener('abort', abort, { once: true });
      socket.write(encodeFrame({ execute, ...(args ? { arguments: args } : {}), id }), (error) => {
        if (error) finish(undefined, error);
      });
    });
  };
  return {
    port: address.port,
    command,
    async status(): Promise<string | undefined> {
      const value = await command('query-status').catch(() => undefined);
      return value &&
        typeof value === 'object' &&
        'status' in value &&
        typeof value.status === 'string'
        ? value.status.slice(0, 64)
        : undefined;
    },
    powerdown() {
      if (!ready || !connection || connection.destroyed) return false;
      connection.write(encodeFrame({ execute: 'system_powerdown', id: 'powerdown' }));
      return true;
    },
    close() {
      connection?.destroy();
      if (server.listening) server.close();
    },
  };
}
