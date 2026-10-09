import type { Workspace, WorkspaceInput } from '../../../shared/ai';
import { api } from './http';
import type { ComputerStatus, QemuSetup, VmResources } from '../../../shared/computer';

export const workspaceService = {
  list: () => api<Workspace[]>('/workspaces'),
  computerSetup: () => api<QemuSetup>('/workspaces/computer-setup'),
  installComputer: () => api<QemuSetup>('/workspaces/computer-setup', 'POST', {}),
  computerStatus: (id: string) =>
    api<ComputerStatus>(`/workspaces/${encodeURIComponent(id)}/computer`),
  controlComputer: (id: string, action: 'start' | 'stop') =>
    api<ComputerStatus>(`/workspaces/${encodeURIComponent(id)}/computer`, 'POST', { action }),
  saveComputerResources: (id: string, resources: VmResources) =>
    api<Workspace>(`/workspaces/${encodeURIComponent(id)}/computer-resources`, 'PUT', resources),
  create: (value: WorkspaceInput) => api<Workspace>('/workspaces', 'POST', value),
  connect: (id: string, value: WorkspaceInput) =>
    api<Workspace>(`/workspaces/${encodeURIComponent(id)}`, 'PUT', value),
  async chooseFolder() {
    if (!window.mukai) return null;
    return window.mukai.chooseWorkspaceFolder();
  },
};
