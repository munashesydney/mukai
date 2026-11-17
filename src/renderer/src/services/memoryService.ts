import { api } from './http';
import type {
  MemoryBackup,
  MemoryFactDetails,
  MemoryImportResult,
  MemorySettings,
  MemorySnapshot,
} from '../../../shared/memory';
const scope = (workspaceId: string) => '?workspaceId=' + encodeURIComponent(workspaceId);
export const memoryService = {
  retryRun: (workspaceId: string, id: string) =>
    api('/memory/runs/retry' + scope(workspaceId), 'POST', { id }),
  snapshot: (workspaceId: string, query: string, history: boolean, page: number, limit: number) => {
    const params = new URLSearchParams({
      workspaceId,
      q: query,
      history: String(history),
      page: String(page),
      limit: String(limit),
    });
    return api<MemorySnapshot>(`/memory?${params}`);
  },
  details: (workspaceId: string, id: string) =>
    api<MemoryFactDetails>('/memory/' + encodeURIComponent(id) + scope(workspaceId)),
  settings: (workspaceId: string, value: MemorySettings) =>
    api<MemorySettings>('/memory/settings' + scope(workspaceId), 'PUT', value),
  embeddings: (workspaceId: string) => api('/memory/embeddings' + scope(workspaceId), 'POST', {}),
  forget: (workspaceId: string, id: string) =>
    api('/memory/' + encodeURIComponent(id) + scope(workspaceId), 'DELETE'),
  forgetEpisode: (workspaceId: string, id: string) =>
    api('/memory/' + encodeURIComponent(id) + '/episode' + scope(workspaceId), 'DELETE'),
  retry: (workspaceId: string, id: string) =>
    api('/memory/' + encodeURIComponent(id) + '/retry' + scope(workspaceId), 'POST', {}),
  correct: (workspaceId: string, id: string, text: string, object: string, validFrom?: string) =>
    api('/memory/' + encodeURIComponent(id) + '/correct' + scope(workspaceId), 'POST', {
      text,
      object,
      validFrom,
    }),
  clear: (workspaceId: string) => api('/memory' + scope(workspaceId), 'DELETE'),
  export: (workspaceId: string) => api<MemoryBackup>('/memory/export' + scope(workspaceId)),
  import: (workspaceId: string, value: unknown) =>
    api<MemoryImportResult>('/memory/import' + scope(workspaceId), 'POST', value),
};
