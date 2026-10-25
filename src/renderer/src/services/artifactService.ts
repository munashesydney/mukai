import type { FileArtifact } from '../../../shared/ai';
import { api, apiFetch } from './http';

export const artifactService = {
  async reference(conversationId: string, href: string, image = false, signal?: AbortSignal) {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await apiFetch(
        `/conversations/${encodeURIComponent(conversationId)}/reference`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ href, image }),
          signal: requestSignal,
        },
      );
      const disposition = response.headers.get('Content-Disposition') || '';
      const encodedName = /filename\*=UTF-8''(.+)$/i.exec(disposition)?.[1];
      return {
        blob: await response.blob(),
        name: encodedName ? decodeURIComponent(encodedName) : 'File',
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (requestSignal.aborted)
        throw new Error(
          'This file took too long to load. Check the workspace computer and try again.',
        );
      throw error;
    }
  },
  list: (botId: string) => api<FileArtifact[]>(`/bots/${encodeURIComponent(botId)}/artifacts`),
  forConversation: (id: string) =>
    api<FileArtifact[]>(`/conversations/${encodeURIComponent(id)}/artifacts`),
  async blob(id: string, signal?: AbortSignal) {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]);
    try {
      return await (
        await apiFetch(`/artifacts/${encodeURIComponent(id)}`, { signal: requestSignal })
      ).blob();
    } catch (error) {
      signal?.throwIfAborted();
      if (requestSignal.aborted)
        throw new Error(
          'This file took too long to load. Check that the workspace computer is running, then try again.',
        );
      throw error;
    }
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
