import type { FailureInbox } from '../../../shared/failures';
import { api } from './http';

export const failureService = {
  list: (offset = 0) => api<FailureInbox>(`/failures?offset=${offset}`),
  dismiss: (id: string) => api<{ ok: boolean }>(`/failures/${encodeURIComponent(id)}`, 'DELETE'),
  dismissAll: () => api<{ ok: boolean }>('/failures', 'DELETE'),
};
