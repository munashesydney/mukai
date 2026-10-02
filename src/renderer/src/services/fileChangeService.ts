import type { FileChangeDetail } from '../../../shared/fileChanges';
import { apiFetch } from './http';

export const fileChangeService = {
  async detail(id: string, signal?: AbortSignal): Promise<FileChangeDetail> {
    const response = await apiFetch(`/changes/${encodeURIComponent(id)}`, { signal });
    return response.json() as Promise<FileChangeDetail>;
  },
};
