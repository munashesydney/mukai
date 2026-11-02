import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { COMPUTER_AUDIO } from '../../shared/computerAudio';

/** Output-only, independently bounded audio; never queues audio behind desktop frames. */
export function relayAudioStream(viewer: WebSocket, upstream: Socket, key: string) {
  let authenticated = false;
  let pending = Buffer.alloc(0);
  let sending = false;
  let closed = false;
  let probeAt = 0;
  let probe = '';
  const close = (code = 1011, message = 'Workspace audio disconnected.') => {
    if (closed) return;
    closed = true;
    clearTimeout(handshake);
    clearInterval(heartbeat);
    upstream.destroy();
    viewer.close(code, message);
    const timer = setTimeout(() => viewer.terminate(), 1000).unref();
    viewer.once('close', () => clearTimeout(timer));
  };
  const handshake = setTimeout(() => close(), 5000).unref();
  const heartbeat = setInterval(() => {
    if (closed || viewer.readyState !== WebSocket.OPEN) return;
    if (probeAt) {
      if (performance.now() - probeAt > 10000) close(1013, 'Audio delivery stalled.');
      return;
    }
    probeAt = performance.now();
    probe = String(probeAt);
    viewer.ping(probe, false, (error) => {
      if (error) close();
    });
  }, 2000).unref();
  viewer.on('pong', (bytes: Buffer) => {
    if (bytes.toString() === probe) {
      if (performance.now() - probeAt > 2000) return close(1013, 'Audio delivery stalled.');
      probeAt = 0;
    }
  });
  viewer.on('message', () => close(1008, 'Audio is output-only.'));
  viewer.on('error', () => close());
  viewer.once('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(handshake);
    upstream.destroy();
  });
  upstream.on('error', () => close());
  upstream.on('close', () => close());
  upstream.once('connect', () => upstream.write(key + '\n'));
  upstream.on('data', (chunk: Buffer) => {
    if (closed) return;
    pending = Buffer.concat([pending, chunk]);
    if (!authenticated) {
      const end = pending.indexOf(10);
      if (end < 0) {
        if (pending.length > 128) close();
        return;
      }
      if (pending.subarray(0, end).toString() !== 'OK') return close();
      authenticated = true;
      clearTimeout(handshake);
      pending = pending.subarray(end + 1);
      viewer.send(JSON.stringify({ ...COMPUTER_AUDIO, startedAt: Date.now() }));
    }
    const completeBytes =
      Math.floor(pending.length / COMPUTER_AUDIO.frameBytes) * COMPUTER_AUDIO.frameBytes;
    if (completeBytes) {
      if (
        !sending &&
        viewer.readyState === WebSocket.OPEN &&
        viewer.bufferedAmount < COMPUTER_AUDIO.frameBytes * 5
      ) {
        // TCP may coalesce several frames. Deliver up to 100ms together, retaining
        // the newest complete frames rather than arbitrarily dropping every other one.
        const bytes = Math.min(completeBytes, COMPUTER_AUDIO.frameBytes * 5);
        const packet = Buffer.allocUnsafe(COMPUTER_AUDIO.headerBytes + bytes);
        packet.writeDoubleLE(Date.now());
        pending.copy(packet, COMPUTER_AUDIO.headerBytes, completeBytes - bytes, completeBytes);
        sending = true;
        viewer.send(packet, { binary: true }, (error) => {
          sending = false;
          if (error) close();
        });
      }
      pending = pending.subarray(completeBytes);
    }
  });
}
