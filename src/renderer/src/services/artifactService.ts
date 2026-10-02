import type { FileArtifact } from '../../../shared/ai';
import { api, apiFetch } from './http';

export const artifactService = {
  list: (botId: string) => api<FileArtifact[]>(`/bots/${encodeURIComponent(botId)}/artifacts`),
  async blob(id: string) {
    return (await apiFetch(`/artifacts/${encodeURIComponent(id)}`)).blob();
  },
};
