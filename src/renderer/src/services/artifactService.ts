import type { FileArtifact } from '../../../shared/ai';
import { api, apiFetch } from './http';
import { RequestScheduler } from '../../../shared/requestScheduler';

const previews = new RequestScheduler(3, 3, 256, 45000);

export const artifactService = {
  async reference(
    conversationId: string,
    href: string,
    image = false,
    signal?: AbortSignal,
    onStart?: () => void,
  ) {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const load = () =>
        apiFetch(`/conversations/${encodeURIComponent(conversationId)}/reference`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ href, image }),
          signal: requestSignal,
        });
      // Hold the slot through body consumption, not just response headers.
      const fetchFile = async () => {
        onStart?.();
        const response = await load();
        return { response, blob: await response.blob() };
      };
      const { response, blob } = image
        ? await previews.run(fetchFile, requestSignal)
        : await fetchFile();
      const disposition = response.headers.get('Content-Disposition') || '';
      const encodedName = /filename\*=UTF-8''(.+)$/i.exec(disposition)?.[1];
      return {
        blob,
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
  async activityImage(
    conversationId: string,
    messageId: string,
    activityId: string,
    signal?: AbortSignal,
  ) {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]);
    return previews.run(
      async () =>
        (
          await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/activity-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId, activityId }),
            signal: requestSignal,
          })
        ).blob(),
      requestSignal,
    );
  },
};
