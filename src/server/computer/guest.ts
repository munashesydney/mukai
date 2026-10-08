import { createReadStream, createWriteStream, readFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { GuestWorker } from './guestWorker';
import { Frames, encodeFrame, guestRequest, PROTOCOL_VERSION, GUEST_REVISION } from './protocol';

// This entry point runs ONLY inside a prepared Linux guest, never in Electron.
if (process.getuid?.() !== 0)
  throw new Error('The guest bridge requires its dedicated root service.');
process.title = 'mukai-bridge';
// Do not let the worker inherit supplementary root groups.
process.setgroups!([]);
const token = readFileSync('/run/mukai-guest/boot-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Missing Mukai boot identity.');
const device = '/dev/virtio-ports/com.mukai.agent';
const account = readFileSync('/etc/passwd', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('mukai:'))
  ?.split(':');
const uid = Number(account?.[2]),
  gid = Number(account?.[3]);
if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0)
  throw new Error('Missing unprivileged guest account.');
const dispatcher = new GuestWorker(join(__dirname, 'guest-worker.cjs'), uid, gid);
const fd = openSync(device, 'r+');
const reader = createReadStream(device, { fd, autoClose: false });
const writer = createWriteStream(device, { fd, autoClose: false });
const frames = new Frames();
const pending = new Map<string, AbortController>();
const send = (value: unknown) => writer.write(encodeFrame(value));
// Handshake is repeated because the host may connect after systemd starts us.
const hello = setInterval(
  () => send({ hello: PROTOCOL_VERSION, revision: GUEST_REVISION, token }),
  500,
);
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
