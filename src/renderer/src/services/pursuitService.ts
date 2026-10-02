import type { Pursuit, PursuitDetail, PursuitRun } from '../../../shared/pursuits';
import { api } from './http';
export const pursuitService = {
  list: (workspaceId: string) =>
    api<Pursuit[]>(`/pursuits?workspaceId=${encodeURIComponent(workspaceId)}`),
  detail: (id: string) => api<PursuitDetail>(`/pursuits/${encodeURIComponent(id)}`),
  status: (id: string, status: 'active' | 'paused') =>
    api<Pursuit>(`/pursuits/${encodeURIComponent(id)}/status`, 'PUT', { status }),
  run: (id: string) => api<PursuitRun>(`/pursuits/${encodeURIComponent(id)}/run`, 'POST'),
};
