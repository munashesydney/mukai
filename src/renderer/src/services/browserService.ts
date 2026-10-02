import { apiFetch } from './http';
import type { BrowserSession } from '../../../shared/runtime';
export const browserService = {
  async list(workspaceId: string): Promise<BrowserSession[]> {
    return (await apiFetch('/browser?workspaceId=' + encodeURIComponent(workspaceId))).json();
  },
  async control(id: string, action: string, url?: string) {
    return (
      await apiFetch(`/browser/${id}/control`, {
        method: 'POST',
        body: JSON.stringify({ action, url }),
      })
    ).json();
  },
};
