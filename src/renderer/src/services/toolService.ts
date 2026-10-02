import type { ToolInfo } from '../../../shared/ai';
import { api } from './http';
export const toolService = {
  list: (workspaceId: string) =>
    api<ToolInfo[]>(`/tools?workspaceId=${encodeURIComponent(workspaceId)}`),
};
