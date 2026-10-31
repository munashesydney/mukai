import type RFB from '@novnc/novnc';

export type ComputerConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Each retry opens a fresh authenticated ticket and RFB stream, never restarts the VM. */
export function maintainComputerConnection(options: {
  open(signal: AbortSignal, reconnect: boolean): Promise<RFB>;
  created(viewer: RFB): void;
  release(): void;
  state(value: ComputerConnectionState, message: string): void;
}) {
  let stopped = false;
  let retries = 0;
  let generation = 0;
  let controller: AbortController | undefined;
  let viewer: RFB | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let unbind: (() => void) | undefined;

  const release = () => {
    generation++;
    controller?.abort();
    clearTimeout(handshakeTimer);
    clearTimeout(stableTimer);
    unbind?.();
    unbind = undefined;
    const previous = viewer;
    viewer = undefined;
    if (previous) {
      // Detach handlers first so our own disconnect cannot schedule another retry.
      previous.disconnect();
      options.release();
    }
  };
  const failed = (message: string, retry = true) => {
    release();
    if (stopped) return;
    if (!retry || retries >= 4) {
      options.state('disconnected', message);
      return;
    }
    const delay = 1000 * 2 ** retries++;
    options.state('connecting', 'Desktop connection interrupted. Reconnecting…');
    retryTimer = setTimeout(() => void connect(), delay);
  };
  const connect = async () => {
    if (stopped) return;
    const current = ++generation;
    controller = new AbortController();
    options.state('connecting', '');
    try {
      const next = await options.open(controller.signal, retries > 0);
      if (stopped || current !== generation) {
        next.disconnect();
        return;
      }
      viewer = next;
      const connected = () => {
        clearTimeout(handshakeTimer);
        clearTimeout(stableTimer);
        options.state('connected', '');
        // Briefly connecting does not reset the budget and cause an endless loop.
        stableTimer = setTimeout(() => (retries = 0), 30000);
      };
      const disconnected = () =>
        failed('The desktop connection closed. Reconnect to return to your computer.');
      const securityFailure = () =>
        failed('Desktop authentication failed. Reconnect to get a fresh session.', false);
      next.addEventListener('connect', connected);
      next.addEventListener('disconnect', disconnected);
      next.addEventListener('securityfailure', securityFailure);
      unbind = () => {
        next.removeEventListener('connect', connected);
        next.removeEventListener('disconnect', disconnected);
        next.removeEventListener('securityfailure', securityFailure);
      };
      handshakeTimer = setTimeout(
        () => failed('The desktop did not respond. Reconnect to try again.'),
        20000,
      );
      options.created(next);
    } catch (error) {
      if (!stopped && current === generation)
        failed(error instanceof Error ? error.message : 'Could not connect to the desktop.');
    }
  };
  void connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      release();
    },
  };
}
