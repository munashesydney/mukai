import { createServer, type Socket } from 'node:net';
import { setupProcess } from './setupProcess';

/** Windows QEMU's stdio console can discard piped input. QMP over TCP avoids it. */
export async function probeAccelerator(
  binary: string,
  accelerator: string,
  signal: AbortSignal,
  onOutput?: (text: string) => void,
) {
  const sockets = new Set<Socket>();
  let complete = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (bytes) => {
      buffer += bytes.toString();
      if (buffer.length > 64000) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.QMP)
            socket.write(
              JSON.stringify({ execute: 'qmp_capabilities', id: 'capabilities' }) + '\n',
            );
          else if (frame.id === 'capabilities' && 'return' in frame)
            socket.write(JSON.stringify({ execute: 'quit', id: 'quit' }) + '\n');
          else if (frame.id === 'quit' && 'return' in frame) {
            complete = true;
            socket.end();
          }
        } catch {
          socket.destroy();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not open the virtualization check socket.');
    const result = await setupProcess(
      binary,
      [
        '-machine',
        'q35',
        '-accel',
        accelerator,
        '-display',
        'none',
        '-nodefaults',
        '-S',
        '-monitor',
        'none',
        '-qmp',
        `tcp:127.0.0.1:${address.port}`,
      ],
      signal,
      undefined,
      onOutput,
      30000,
    );
    return { ...result, code: result.code === 0 && !complete ? -1 : result.code };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
