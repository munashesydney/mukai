import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { GuestWorker } from './guestWorker';
import { guestRequest, PROTOCOL_VERSION, GUEST_REVISION } from './protocol';
import { collectGuestHealth, GuestHealthLog, GUEST_HEALTH_INTERVAL_MS } from './guestHealth';
import { GuestTransport, openGuestChannel } from './guestTransport';
import { GuestHelpers } from './helpers';

// This entry point runs ONLY inside a prepared Linux guest, never in Electron.
if (process.getuid?.() !== 0)
  throw new Error('The guest bridge requires its dedicated root service.');
process.title = 'mukai-bridge';
// Do not let the worker inherit supplementary root groups.
process.setgroups!([]);
const token = readFileSync('/run/mukai-guest/boot-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Missing Mukai boot identity.');
const account = readFileSync('/etc/passwd', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('mukai:'))
  ?.split(':');
const uid = Number(account?.[2]),
  gid = Number(account?.[3]);
if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0)
  throw new Error('Missing unprivileged guest account.');
const dispatcher = new GuestWorker(join(__dirname, 'guest-worker.cjs'), uid, gid);
const pending = new Map<string, AbortController>();
const healthLog = new GuestHealthLog();
let sample: ReturnType<typeof collectGuestHealth> | undefined;
let stopping = false;
let logFailed = false;
let telemetryRunning = false;
const helpers = new GuestHelpers((frame) => {
  if (!transport.send(frame)) throw new Error('Guest helper transport is unavailable.');
});
const health = () => {
  if (!sample)
    sample = collectGuestHealth({ workerPid: dispatcher.pid }).finally(() => {
      sample = undefined;
    });
  return sample;
};
const telemetry = async () => {
  if (stopping || telemetryRunning) return;
  telemetryRunning = true;
  try {
    const diagnostics = await health();
    if (stopping) return;
    transport.send({ telemetry: diagnostics }, true);
    await healthLog.append(diagnostics);
    logFailed = false;
  } catch {
    // Never interrupt tool execution if the evidence log's filesystem is unavailable.
    if (!logFailed) console.error('Guest health log unavailable.');
    logFailed = true;
  } finally {
    telemetryRunning = false;
  }
};
const transport = new GuestTransport({
  open: () => openGuestChannel('/dev/virtio-ports/com.mukai.agent'),
  hello: { hello: PROTOCOL_VERSION, revision: GUEST_REVISION, token },
  onReady: () => {
    void telemetry();
  },
  onError: () => console.error('Guest transport unavailable; reconnecting.'),
  onFrame: (raw) => {
    if (helpers.reply(raw)) return;
    const control = z.object({ cancel: z.string().uuid() }).safeParse(raw);
    if (control.success) {
      pending.get(control.data.cancel)?.abort();
      return;
    }
    const probe = z.object({ health: z.string().uuid() }).safeParse(raw);
    if (probe.success) {
      void health()
        .then((diagnostics) => transport.send({ health: probe.data.health, diagnostics }))
        .catch(() => {});
      return;
    }
    const request = guestRequest.parse(raw);
    if (pending.size >= 32 || pending.has(request.id)) {
      transport.send({
        id: request.id,
        error: 'Guest is busy. Retry after outstanding calls finish.',
      });
      return;
    }
    const controller = new AbortController();
    pending.set(request.id, controller);
    void dispatcher
      .request(
        request.method,
        request.input,
        request.owner,
        controller.signal,
        request.method === 'capability'
          ? helpers.forRequest(request.id, controller.signal)
          : undefined,
      )
      .then((result) => transport.send({ id: request.id, result }))
      .catch((error) =>
        transport.send({
          id: request.id,
          error: error instanceof Error ? error.message : 'Guest operation failed.',
        }),
      )
      .finally(() => {
        pending.delete(request.id);
        controller.abort();
      });
  },
});
transport.start();
// Local evidence continues while disconnected; host delivery requires authentication.
const healthTimer = setInterval(() => {
  void telemetry();
}, GUEST_HEALTH_INTERVAL_MS);
healthTimer.unref();
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(healthTimer);
  transport.close();
  for (const controller of pending.values()) controller.abort();
  void dispatcher.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
