import type {
  Pursuit,
  PursuitDetail,
  PursuitRun,
  WorkpadPage,
  WorkpadQuery,
  WorkpadEntry,
} from '../../../shared/pursuits';
import { api } from './http';
export const pursuitService = {
  list: (workspaceId: string) =>
    api<Pursuit[]>(`/pursuits?workspaceId=${encodeURIComponent(workspaceId)}`),
  detail: (id: string) => api<PursuitDetail>(`/pursuits/${encodeURIComponent(id)}`),
  workpadEntry: (id: string, entryId: string) =>
    api<WorkpadEntry>(
      `/pursuits/${encodeURIComponent(id)}/workpad?entryId=${encodeURIComponent(entryId)}`,
    ),
  workpad: (id: string, query: WorkpadQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return api<WorkpadPage>(`/pursuits/${encodeURIComponent(id)}/workpad?${params}`);
  },
  status: (id: string, status: 'active' | 'paused') =>
    api<Pursuit>(`/pursuits/${encodeURIComponent(id)}/status`, 'PUT', { status }),
  run: (id: string) => api<PursuitRun>(`/pursuits/${encodeURIComponent(id)}/run`, 'POST'),
  runDetail: (id: string, runId: string) =>
    api<PursuitRun>(`/pursuits/${encodeURIComponent(id)}/run?runId=${encodeURIComponent(runId)}`),
};
