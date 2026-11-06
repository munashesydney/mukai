import type { TrajectoryDetail, TrajectoryRecord } from '../../../shared/trajectory';
import { api } from './http';

function path(conversationId: string) {
  return `/conversations/${encodeURIComponent(conversationId)}/trajectory`;
}

export const trajectoryService = {
  list: (conversationId: string, from?: string) =>
    api<TrajectoryRecord[]>(
      path(conversationId) + (from ? `?from=${encodeURIComponent(from)}` : ''),
    ),
  detail: (conversationId: string, recordId: number) =>
    api<TrajectoryDetail>(`${path(conversationId)}?record=${recordId}`),
};
