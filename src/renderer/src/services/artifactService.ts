import type { FileArtifact } from '../../../shared/ai';
import { api, apiFetch } from './http';

export const artifactService = {
  list: (botId: string) => api<FileArtifact[]>(`/bots/${encodeURIComponent(botId)}/artifacts`),
  forConversation: (id: string) =>
    api<FileArtifact[]>(`/conversations/${encodeURIComponent(id)}/artifacts`),
  async blob(id: string) {
    return (await apiFetch(`/artifacts/${encodeURIComponent(id)}`)).blob();
  },
  async activityImage(conversationId: string, messageId: string, activityId: string) {
    return (
      await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/activity-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, activityId }),
      })
    ).blob();
  },
};
