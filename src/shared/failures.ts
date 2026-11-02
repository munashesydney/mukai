import type { Conversation } from './conversations';

export interface ChatFailure {
  id: string;
  workspaceId: string;
  workspaceName: string;
  botName: string;
  failedAt: string;
  error: string;
  conversation: Conversation;
  pursuitId?: string;
  runId?: string;
}
export interface FailureInbox {
  items: ChatFailure[];
  total: number;
}
