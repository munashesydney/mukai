import { useSyncExternalStore } from 'react';
import type { ApprovalMode, ApprovalState } from '../../../../shared/approvals';
import { approvalService } from '../../services/approvalService';
import { startPoll, type PollHandle } from '../../services/poll';
import { errorText } from '../../utils/errors';

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
    if (refreshing) return 'busy';
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
      if (currentVersion === version) update({ error: errorText(caught) });
      return 'failed';
    } finally {
      refreshing = false;
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
    poll = startPoll(async () => {
      const outcome = await approvalStore.refresh();
      return outcome === 'changed' || outcome === 'busy';
    }, { interval: 1000, maxInterval: 3000 });
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
