import type { ComputerStatus, ComputerViewSession } from '../../../shared/computer';
import { apiFetch, apiWebSocketUrl } from './http';

export const computerService = {
  async status(workspaceId: string, signal?: AbortSignal) {
    const response = await apiFetch(`/workspaces/${workspaceId}/computer`, { signal });
    return (await response.json()) as ComputerStatus;
  },
  async view(workspaceId: string, signal: AbortSignal, reconnect = false) {
    const response = await apiFetch(
      `/workspaces/${workspaceId}/computer-view${reconnect ? '?reconnect=1' : ''}`,
      {
        method: 'POST',
        signal,
      },
    );
    const session = (await response.json()) as ComputerViewSession;
    return { url: await apiWebSocketUrl(session.path), password: session.password };
  },
};
