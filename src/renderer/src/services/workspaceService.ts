import type { Workspace, WorkspaceInput } from '../../../shared/ai';
import { api } from './http';
import type { ComputerStatus, QemuSetup } from '../../../shared/computer';

export const workspaceService = {
  list: () => api<Workspace[]>('/workspaces'),
  computerSetup: () => api<QemuSetup>('/workspaces/computer-setup'),
  computerStatus: (id: string) =>
    api<ComputerStatus>(`/workspaces/${encodeURIComponent(id)}/computer`),
  controlComputer: (id: string, action: 'start' | 'stop') =>
    api<ComputerStatus>(`/workspaces/${encodeURIComponent(id)}/computer`, 'POST', { action }),
  create: (value: WorkspaceInput) => api<Workspace>('/workspaces', 'POST', value),
  connect: (id: string, value: WorkspaceInput) =>
    api<Workspace>(`/workspaces/${encodeURIComponent(id)}`, 'PUT', value),
  async chooseFolder() {
    if (!window.mukai) return null;
    return window.mukai.chooseWorkspaceFolder();
  },
};
