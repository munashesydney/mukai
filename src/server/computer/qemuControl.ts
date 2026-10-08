import { createServer, type Socket } from 'node:net';
import { Frames, encodeFrame } from './protocol';

/** Private QMP connection established before the guest boots. Stop listening once QEMU connects. */
export async function qemuControl() {
  let connection: Socket | undefined;
  let ready = false;
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
    });
    socket.on('data', (bytes) => {
      try {
        for (const frame of frames.push(bytes)) {
          if (!frame || typeof frame !== 'object') throw new Error('Invalid QMP frame.');
          if ('QMP' in frame)
            socket.write(encodeFrame({ execute: 'qmp_capabilities', id: 'capabilities' }));
          else if ('id' in frame && frame.id === 'capabilities' && 'return' in frame) ready = true;
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
