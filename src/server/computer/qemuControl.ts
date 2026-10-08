import { createServer, type Socket } from 'node:net';
import { Frames, encodeFrame } from './protocol';

/** Private QMP connection established before the guest boots. Stop listening once QEMU connects. */
export async function qemuControl(onEvent?: (event: string, reason?: string) => void) {
  let connection: Socket | undefined;
  let ready = false;
  let sequence = 0;
  const queries = new Map<string, (status?: string) => void>();
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
            const result =
              'return' in frame && frame.return && typeof frame.return === 'object'
                ? frame.return
                : undefined;
            queries.get(frame.id)?.(
              result && 'status' in result && typeof result.status === 'string'
                ? result.status.slice(0, 64)
                : undefined,
            );
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
  return {
    port: address.port,
    status(): Promise<string | undefined> {
      if (!ready || !connection || connection.destroyed) return Promise.resolve(undefined);
      if (queries.size >= 4) return Promise.resolve(undefined);
      const socket = connection;
      const id = `status-${++sequence}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(), 5000);
        const finish = (status?: string) => {
          clearTimeout(timer);
          queries.delete(id);
          resolve(status);
        };
        queries.set(id, finish);
        socket.write(encodeFrame({ execute: 'query-status', id }), (error) => {
          if (error) finish();
        });
      });
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
