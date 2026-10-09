import { useSyncExternalStore } from 'react';
import type { ApprovalMode, ApprovalState } from '../../../../shared/approvals';
import { approvalService } from '../../services/approvalService';
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
let timer: ReturnType<typeof setInterval> | undefined;
let version = 0;
let modeRequest = 0;
let refreshing = false;
function update(value: Partial<State>) {
  state = { ...state, ...value };
  listeners.forEach((listener) => listener());
}
export const approvalStore = {
  setWorkspace(workspaceId: string) {
    if (workspaceId === state.workspaceId) return;
    version++;
    modeRequest++;
    update({ workspaceId, loaded: false, saving: false, error: '' });
    void this.refresh();
  },
  async refresh() {
    if (refreshing) return;
    refreshing = true;
    const currentVersion = version;
    try {
      const result = await approvalService.state(state.workspaceId);
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
  async decide(id: string, approved: boolean) {
    if (state.deciding.includes(id)) return;
    version++;
    update({ deciding: [...state.deciding, id], error: '' });
    const workspaceId = state.workspaceId;
    try {
      const result = await approvalService.decide(id, approved, workspaceId);
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
