import type { ApprovalMode, ApprovalState } from '../../../shared/approvals';
import { api } from './http';

export const approvalService = {
  state: () => api<ApprovalState>('/approvals'),
  setMode: (mode: ApprovalMode) => api<ApprovalState>('/approvals', 'PUT', { mode }),
  decide: (id: string, approved: boolean) =>
    api<ApprovalState>(`/approvals/${encodeURIComponent(id)}`, 'POST', { approved }),
  decideBatch: (conversationId: string, batchId: string, ids: string[], approved: boolean) =>
    api<ApprovalState>('/approvals/batch', 'POST', { conversationId, batchId, ids, approved }),
};
