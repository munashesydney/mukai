import type { DesktopUpdateState } from '../../../shared/contracts';
import { api } from './http';
import { startPoll } from './poll';

const changed = 'mukai:update-state-changed';
let browserVersion: string | undefined;
let reconnecting = false;
const publish = (state: DesktopUpdateState) => {
  window.dispatchEvent(new CustomEvent(changed, { detail: state }));
  return state;
};

async function reconnect(previousState: DesktopUpdateState) {
  if (reconnecting) return;
  const previousVersion = previousState.currentVersion;
  reconnecting = true;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((done) => setTimeout(done, 1000));
      try {
        const response = await fetch('/health', {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (
          response.ok &&
          ((await response.json()) as { version: string }).version !== previousVersion
        ) {
          window.location.reload();
          return;
        }
      } catch {
        /* The server is expected to disconnect while changing runtimes. */
      }
    }
    publish({
      ...previousState,
      status: 'error',
      message:
        'Mukai has not reconnected. Check the terminal for startup errors, then refresh this page.',
    });
  } finally {
    reconnecting = false;
  }
}

export const updateService = {
  async getUpdateState() {
    if (window.mukai) return window.mukai.getUpdateState();
    const state = await api<DesktopUpdateState>('/settings/updates');
    if (browserVersion && browserVersion !== state.currentVersion) window.location.reload();
    browserVersion = state.currentVersion;
    if (state.status === 'installing') void reconnect(state);
    return state;
  },
  async checkForUpdates() {
    return window.mukai
      ? window.mukai.checkForUpdates()
      : publish(await api<DesktopUpdateState>('/settings/updates/check', 'POST'));
  },
  async setAutomaticUpdates(enabled: boolean) {
    return window.mukai
      ? window.mukai.setAutomaticUpdates(enabled)
      : publish(await api<DesktopUpdateState>('/settings/updates', 'PUT', { enabled }));
  },
  async restartToUpdate() {
    if (window.mukai) return window.mukai.restartToUpdate();
    if (
      !window.confirm(
        'Restart Mukai to install the update? Running bots and tools will stop. Your saved work is preserved.',
      )
    )
      return;
    const state = await updateService.getUpdateState();
    await api('/settings/updates/restart', 'POST', { confirm: true });
    publish({ ...state, status: 'installing' });
    void reconnect(state);
  },
  onUpdateState(listener: (state: DesktopUpdateState) => void) {
    if (window.mukai) return window.mukai.onUpdateState(listener);
    let active = true;
    const receive = (event: Event) => listener((event as CustomEvent<DesktopUpdateState>).detail);
    window.addEventListener(changed, receive);
    // Update state is interesting for a few seconds at a time: while something is
    // downloading or installing it moves on every tick, and otherwise it does not
    // move at all. One poller covers both by backing off from its own readings.
    let lastPayload = '';
    const poll = startPoll(async () => {
      let state: DesktopUpdateState;
      try {
        state = await updateService.getUpdateState();
      } catch {
        // Reconnect and authentication are handled by the existing app lifecycle;
        // returning false just stops hammering a server that is not there yet.
        return false;
      }
      const payload = JSON.stringify(state);
      const unchanged = payload === lastPayload;
      lastPayload = payload;
      if (!unchanged && active) listener(state);
      return !unchanged;
    }, { interval: 1500, maxInterval: 30_000 });
    return () => {
      active = false;
      poll.stop();
      window.removeEventListener(changed, receive);
    };
  },
};
