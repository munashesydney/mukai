import { GuestDispatcher } from './guestDispatcher';
import { encodeFrame, guestRequest } from './protocol';

// Only the unprivileged worker executes bot tools. It never receives the boot token or serial FD.
if (!process.send || process.getuid?.() === 0)
  throw new Error('Guest worker requires an unprivileged IPC session.');
process.title = 'mukai-tools';
const dispatcher = new GuestDispatcher('/home/mukai/workspace', '/var/lib/mukai-guest');
const pending = new Map<string, AbortController>();
const send = (value: unknown) => {
  encodeFrame(value); // Apply the same byte bound to IPC and the external bridge.
  if (process.connected) process.send!(value);
};
process.on('message', (raw) => {
  if (raw && typeof raw === 'object' && 'cancel' in raw && typeof raw.cancel === 'string') {
    pending.get(raw.cancel)?.abort();
    return;
  }
  const parsed = guestRequest.safeParse(raw);
  if (!parsed.success) return;
  const request = parsed.data;
  if (pending.size >= 32 || pending.has(request.id)) {
    send({ id: request.id, error: 'Guest worker is busy.' });
    return;
  }
  const controller = new AbortController();
  pending.set(request.id, controller);
  void dispatcher
    .request(request.method, request.input, request.owner, controller.signal)
    .then((result) => send({ id: request.id, result }))
    .catch((error) =>
      send({
        id: request.id,
        error: error instanceof Error ? error.message : 'Guest tool failed.',
      }),
    )
    .finally(() => pending.delete(request.id));
});
const stop = () => {
  for (const controller of pending.values()) controller.abort();
  void dispatcher.shutdown().finally(() => process.exit(0));
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
