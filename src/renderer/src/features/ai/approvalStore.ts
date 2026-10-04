import { useSyncExternalStore } from 'react';
import type { ApprovalMode, ApprovalState } from '../../../../shared/approvals';
import { approvalService } from '../../services/approvalService';
import { errorText } from '../../utils/errors';

interface State extends ApprovalState {
  loaded: boolean;
  saving: boolean;
  deciding: string[];
  error: string;
}
let state: State = {
  mode: 'full-access',
  pending: [],
  loaded: false,
  saving: false,
  deciding: [],
  error: '',
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let version = 0;
let refreshing = false;
function update(value: Partial<State>) {
  state = { ...state, ...value };
  listeners.forEach((listener) => listener());
}
export const approvalStore = {
  async refresh() {
    if (refreshing) return;
    refreshing = true;
    const currentVersion = version;
    try {
      const result = await approvalService.state();
      if (currentVersion === version) update({ ...result, loaded: true, error: '' });
    } catch (caught) {
      if (currentVersion === version) update({ error: errorText(caught) });
    } finally {
      refreshing = false;
    }
  },
  async setMode(mode: ApprovalMode) {
    if (state.saving) return;
    version++;
    update({ saving: true, error: '' });
    try {
      const result = await approvalService.setMode(mode);
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      update({ error: errorText(caught) });
    } finally {
      update({ saving: false });
    }
  },
  async decide(id: string, approved: boolean) {
    if (state.deciding.includes(id)) return;
    version++;
    update({ deciding: [...state.deciding, id], error: '' });
    try {
      const result = await approvalService.decide(id, approved);
      version++;
      update({ ...result, loaded: true });
    } catch (caught) {
      update({ error: errorText(caught) });
    } finally {
      update({ deciding: state.deciding.filter((item) => item !== id) });
    }
  },
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void approvalStore.refresh();
    timer = setInterval(() => void approvalStore.refresh(), 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function useApprovals() {
  return useSyncExternalStore(subscribe, () => state);
}
