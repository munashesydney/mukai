import { useSyncExternalStore } from 'react';
import type { ApprovalMode, ApprovalState } from '../../../../shared/approvals';
import { approvalService } from '../../services/approvalService';
import { startPoll, type PollHandle } from '../../services/poll';
import { errorText, isCancellation } from '../../utils/errors';

interface State extends ApprovalState {
  workspaceId: string;
  loaded: boolean;
  saving: boolean;
  deciding: string[];
  error: string;
}
let state: State = {
  workspaceId: 'default',
  mode: 'full-access',
  pending: [],
  loaded: false,
  saving: false,
  deciding: [],
  error: '',
};
const listeners = new Set<() => void>();
let poll: PollHandle | undefined;
let version = 0;
let modeRequest = 0;
let refreshing = false;
/** A refresh pressed while another look is in flight; that pass owes us one more. */
let retryRequested = false;
let lastPayload = '';

/**
 * What one refresh actually found. `unchanged` is the only answer that lets the
 * poller wait longer; the others keep the base cadence (or, for `failed`, let the
 * poller back off from an endpoint that is not answering).
 */
type RefreshResult = 'changed' | 'unchanged' | 'failed' | 'busy';
function update(value: Partial<State>) {
  state = { ...state, ...value };
  listeners.forEach((listener) => listener());
}
export const approvalStore = {
  setWorkspace(workspaceId: string) {
    if (workspaceId === state.workspaceId) return;
    version++;
    modeRequest++;
    lastPayload = ''; // a different workspace is different data, not unchanged data
    update({ workspaceId, loaded: false, saving: false, error: '' });
    void this.refresh();
  },
  async refresh(): Promise<RefreshResult> {
    if (refreshing) {
      // A look already in flight must not swallow this one. Without this the
      // "Refresh permissions" button was a no-op whenever it landed during a poll —
      // which, at one request per second against a server that is slow rather than
      // dead, is most of the time.
      retryRequested = true;
      return 'busy';
    }
    // This pass is the immediate look the caller asked for, so the poll does not need
    // nudging. Nudging it here would look harmless and not be: `poll.refresh()` runs its
    // tick synchronously up to the first await, and that tick re-enters this method while
    // `refreshing` is still false, so one press would fire two requests at once and the
    // first `finally` would clear the flag out from under the second pass.
    refreshing = true;
    const currentVersion = version;
    try {
      const result = await approvalService.state(state.workspaceId);
      if (currentVersion !== version) return 'changed'; // a workspace switch owns this answer
      const payload = JSON.stringify(result);
      const unchanged = payload === lastPayload && state.loaded && !state.error;
      lastPayload = payload;
      // Identical bytes, identical state: skip the notify, so an idle approval list costs
      // no re-renders, and tell the poller it may wait longer before asking again.
      if (!unchanged) update({ ...result, loaded: true, error: '' });
      return unchanged ? 'unchanged' : 'changed';
    } catch (caught) {
      // A cancelled look is not an outage. The polls that keep this panel live are
      // routinely aborted by the browser — a navigation, a view that unmounted, the
      // caller's own signal — and reading that as "start the backend" raised the banner
      // over a server answering every other request with 200s. Nothing was learned, so
      // keep the last good answer and the same cadence, exactly as a busy pass does.
      if (isCancellation(caught)) return 'busy';
      if (currentVersion === version) update({ error: errorText(caught) });
      return 'failed';
    } finally {
      refreshing = false;
      if (retryRequested) {
        // One extra pass per request, however many presses arrived during it.
        retryRequested = false;
        void this.refresh();
      }
    }
  },
  async setMode(mode: ApprovalMode) {
    if (state.saving) return;
    version++;
    update({ saving: true, error: '' });
    const workspaceId = state.workspaceId;
    const request = ++modeRequest;
    try {
      const result = await approvalService.setMode(mode, workspaceId);
      if (state.workspaceId !== workspaceId || request !== modeRequest) return;
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      if (state.workspaceId === workspaceId && request === modeRequest)
        update({ error: errorText(caught) });
    } finally {
      if (state.workspaceId === workspaceId && request === modeRequest) update({ saving: false });
    }
  },
  async decide(id: string, approved: boolean, reason?: string) {
    if (state.deciding.includes(id)) return;
    version++;
    update({ deciding: [...state.deciding, id], error: '' });
    const workspaceId = state.workspaceId;
    try {
      const result = await approvalService.decide(id, approved, workspaceId, reason);
      if (state.workspaceId !== workspaceId) return;
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      if (state.workspaceId === workspaceId) update({ error: errorText(caught) });
    } finally {
      update({ deciding: state.deciding.filter((item) => item !== id) });
    }
  },
  async decideBatch(conversationId: string, batchId: string, ids: string[]) {
    if (ids.some((id) => state.deciding.includes(id))) return;
    version++;
    update({ deciding: [...state.deciding, ...ids], error: '' });
    const workspaceId = state.workspaceId;
    try {
      const result = await approvalService.decideBatch(
        conversationId,
        batchId,
        ids,
        true,
        workspaceId,
      );
      if (state.workspaceId !== workspaceId) return;
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      if (state.workspaceId === workspaceId) update({ error: errorText(caught) });
    } finally {
      update({ deciding: state.deciding.filter((id) => !ids.includes(id)) });
    }
  },
  async answer(id: string, answer: string) {
    if (state.deciding.includes(id)) return;
    version++;
    update({ deciding: [...state.deciding, id], error: '' });
    const workspaceId = state.workspaceId;
    try {
      const result = await approvalService.answer(id, answer, workspaceId);
      if (state.workspaceId !== workspaceId) return;
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      if (state.workspaceId === workspaceId) update({ error: errorText(caught) });
    } finally {
      update({ deciding: state.deciding.filter((item) => item !== id) });
    }
  },
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    // A pending approval is worth looking for every second, but a list that has not
    // moved in a while is not: it drifts to three seconds and comes straight back
    // when anything changes, when the window is refocused, or after a local decision.
    poll = startPoll(
      async () => {
        const outcome = await approvalStore.refresh();
        return outcome === 'changed' || outcome === 'busy';
      },
      { interval: 1000, maxInterval: 3000 },
    );
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      poll?.stop();
      poll = undefined;
    }
  };
}
export function useApprovals() {
  return useSyncExternalStore(subscribe, () => state);
}
