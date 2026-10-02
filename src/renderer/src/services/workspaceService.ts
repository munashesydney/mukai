import type { Workspace, WorkspaceInput } from '../../../shared/ai';
import { api } from './http';

export const workspaceService = {
  list: () => api<Workspace[]>('/workspaces'),
  create: (value: WorkspaceInput) => api<Workspace>('/workspaces', 'POST', value),
  connect: (id: string, value: WorkspaceInput) =>
    api<Workspace>(`/workspaces/${encodeURIComponent(id)}`, 'PUT', value),
  async chooseFolder() {
    if (!window.mukai) return null;
    return window.mukai.chooseWorkspaceFolder();
  },
};
