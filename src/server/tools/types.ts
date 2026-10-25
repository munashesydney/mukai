import type { ChatActivity } from '../../shared/ai';
import type { WorkspaceFileService } from '../services/workspaceFileService';

export interface ToolContext {
  botId: string;
  signal: AbortSignal;
  files: WorkspaceFileService;
  onActivity: (activity: ChatActivity) => void;
  onFileChanged: (
    path: string,
    metadata?: import('../../shared/fileMetadata').FileMetadata,
  ) => import('../../shared/responseReferences').SavedFileReference | void;
  copyOnly?: boolean;
  attachmentBytes?: (id: string) => Promise<Buffer>;
  callBudget: { remaining: number };
}
export type ToolScope = { type: 'all-bots' } | { type: 'selected-bots'; botIds: readonly string[] };
