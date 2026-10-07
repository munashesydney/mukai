import { createReadStream, createWriteStream, readFileSync, mkdirSync, openSync } from 'node:fs';
import { z } from 'zod';
import { GuestDispatcher } from './guestDispatcher';
import { Frames, encodeFrame, guestRequest, PROTOCOL_VERSION } from './protocol';

// This entry point runs ONLY inside a prepared Linux guest, never in Electron.
const token = readFileSync('/run/mukai-guest/boot-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Missing Mukai boot identity.');
const device = '/dev/virtio-ports/com.mukai.agent';
const folder = '/home/mukai/workspace';
const dataDir = '/var/lib/mukai-guest';
mkdirSync(folder, { recursive: true });
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dispatcher = new GuestDispatcher(folder, dataDir);
const fd = openSync(device, 'r+');
const reader = createReadStream(device, { fd, autoClose: false });
const writer = createWriteStream(device, { fd, autoClose: false });
const frames = new Frames();
const pending = new Map<string, AbortController>();
const send = (value: unknown) => writer.write(encodeFrame(value));
// Handshake is repeated because the host may connect after systemd starts us.
const hello = setInterval(() => send({ hello: PROTOCOL_VERSION, token }), 500);
reader.on('data', (chunk) => {
  try {
    for (const raw of frames.push(Buffer.from(chunk))) {
      const control = z.object({ cancel: z.string().uuid() }).safeParse(raw);
      if (control.success) {
        pending.get(control.data.cancel)?.abort();
        continue;
      }
      const ready = z.object({ ready: z.literal(PROTOCOL_VERSION) }).safeParse(raw);
      if (ready.success) {
        clearInterval(hello);
        continue;
      }
      const request = guestRequest.parse(raw);
      if (pending.size >= 32 || pending.has(request.id)) {
        send({ id: request.id, error: 'Guest is busy. Retry after outstanding calls finish.' });
        continue;
      }
      const controller = new AbortController();
      pending.set(request.id, controller);
      void dispatcher
        .request(request.method, request.input, request.owner, controller.signal)
        .then((result) => send({ id: request.id, result }))
        .catch((error) =>
          send({
            id: request.id,
            error: error instanceof Error ? error.message : 'Guest operation failed.',
          }),
        )
        .finally(() => pending.delete(request.id));
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
writer.on('error', () => process.exit(1));
reader.on('error', () => process.exit(1));
const stop = () => {
  for (const controller of pending.values()) controller.abort();
  void dispatcher.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
