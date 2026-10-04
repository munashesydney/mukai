import type { ToolInfo } from '../../../shared/ai';
import { api } from './http';
import type { ToolAssignment } from '../../../shared/toolAssignments';
export const toolService = {
  assignments: (workspaceId: string) =>
    api<ToolAssignment[]>(`/tools/assignments?workspaceId=${encodeURIComponent(workspaceId)}`),
  assign: (workspaceId: string, botId: string, toolId: string, enabled: boolean) =>
    api<ToolAssignment>(
      `/tools/assignments?workspaceId=${encodeURIComponent(workspaceId)}`,
      'PUT',
      { botId, toolId, enabled },
    ),
  list: (workspaceId: string) =>
    api<ToolInfo[]>(`/tools?workspaceId=${encodeURIComponent(workspaceId)}`),
};
