import type { Socket } from 'node:net';
import { WebSocket } from 'ws';

const HEARTBEAT_INTERVAL = 2000;
const STALL_TIMEOUT = 10000;

/** Relay the ordered RFB stream without accumulating screen updates in user space. */
export function relayDesktopStream(
  viewer: WebSocket,
  upstream: Socket,
  reportRecovery?: (reason: string, roundTripMs: number, bufferedBytes: number) => void,
) {
  let closing = false;
  let writeStarted: number | undefined;
  let probe: { payload: Buffer; sentAt: number } | undefined;
  let sequence = 0;
  let minimumRoundTrip = Infinity;
  let roundTrip = 0;
  let slowProbes = 0;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;

  const close = (code = 1011, reason = 'Desktop connection closed.') => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    upstream.destroy();
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.close(code, reason);
      // A close frame can itself be stuck behind old display data in a proxy.
      terminateTimer = setTimeout(() => viewer.terminate(), 1000).unref();
    }
  };
  const recover = (reason: string) => {
    reportRecovery?.(reason, Math.round(roundTrip), viewer.bufferedAmount);
    close(1013, 'Desktop delivery stalled. Reconnect for a fresh display.');
  };
  const heartbeat = setInterval(() => {
    if (closing || viewer.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (writeStarted !== undefined && now - writeStarted >= STALL_TIMEOUT)
      return recover('write-timeout');
    if (probe) {
      if (now - probe.sentAt >= STALL_TIMEOUT) return recover('heartbeat-timeout');
      return;
    }
    // Ping travels through the same connection as the display, so its RTT also
    // sees downstream/proxy buffering that bufferedAmount cannot measure.
    probe = { payload: Buffer.from(String(++sequence)), sentAt: now };
    viewer.ping(probe.payload, false, (error) => {
      if (error) close();
    });
  }, HEARTBEAT_INTERVAL).unref();

  viewer.on('pong', (payload: Buffer) => {
    if (closing || !probe || !payload.equals(probe.payload)) return;
    roundTrip = performance.now() - probe.sentAt;
    probe = undefined;
    minimumRoundTrip = Math.min(minimumRoundTrip, roundTrip);
    // One busy frame or a naturally distant client must not trigger recovery.
    slowProbes = roundTrip > Math.max(2000, minimumRoundTrip + 1500) ? slowProbes + 1 : 0;
    if (slowProbes >= 3) recover('sustained-latency');
  });
  viewer.on('error', () => close());
  viewer.once('close', () => {
    closing = true;
    clearInterval(heartbeat);
    clearTimeout(terminateTimer);
    upstream.off('drain', resumeInput);
    upstream.destroy();
  });
  upstream.on('error', () => close());
  upstream.on('close', () => close());
  const resumeInput = () => {
    if (!closing) viewer.resume();
  };
  upstream.on('drain', resumeInput);
  viewer.on('message', (data, binary) => {
    if (closing) return;
    if (!binary || upstream.writableLength > 4 * 1024 * 1024) {
      close(1008, 'Invalid or excessive desktop input.');
      return;
    }
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (!upstream.write(bytes)) viewer.pause();
  });
  upstream.on('data', (bytes: Buffer) => {
    if (closing || viewer.readyState !== WebSocket.OPEN) return;
    // One TCP chunk in flight at a time. The callback fires when the local
    // WebSocket write drains; pausing propagates pressure back to TigerVNC.
    // Never discard bytes: later RFB updates depend on earlier stream state.
    upstream.pause();
    writeStarted = performance.now();
    viewer.send(bytes, { binary: true }, (error) => {
      writeStarted = undefined;
      if (error) close();
      else if (!closing) upstream.resume();
    });
  });
}
