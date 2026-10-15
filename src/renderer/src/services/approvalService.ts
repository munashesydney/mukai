import type { ApprovalMode, ApprovalState } from '../../../shared/approvals';
import { api } from './http';

export const approvalService = {
  state: (workspaceId: string) =>
    api<ApprovalState>(`/approvals?workspaceId=${encodeURIComponent(workspaceId)}`),
  setMode: (mode: ApprovalMode, workspaceId: string) =>
    api<ApprovalState>(`/approvals?workspaceId=${encodeURIComponent(workspaceId)}`, 'PUT', {
      mode,
    }),
  decide: (id: string, approved: boolean, workspaceId: string, reason?: string) =>
    api<ApprovalState>(
      `/approvals/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      'POST',
      { approved, ...(reason === undefined ? {} : { reason }) },
    ),
  answer: (id: string, answer: string, workspaceId: string) =>
    api<ApprovalState>(
      `/approvals/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      'POST',
      { answer },
    ),
  decideBatch: (
    conversationId: string,
    batchId: string,
    ids: string[],
    approved: boolean,
    workspaceId: string,
  ) =>
    api<ApprovalState>(`/approvals/batch?workspaceId=${encodeURIComponent(workspaceId)}`, 'POST', {
      conversationId,
      batchId,
      ids,
      approved,
    }),
};
