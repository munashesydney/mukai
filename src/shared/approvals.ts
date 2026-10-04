export type ApprovalMode = 'ask-for-approval' | 'full-access';

export interface ApprovalTarget {
  kind: 'private' | 'space' | 'pursuit_run';
  workspaceId: string;
  name: string;
  pursuitId?: string;
  runId?: string;
}

export interface ToolApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  botId: string;
  botName: string;
  conversationId: string;
  messageId: string;
  /** Calls emitted in the same model step share one approval group. */
  batchId: string;
  createdAt: string;
  target?: ApprovalTarget;
}

export interface ApprovalState {
  mode: ApprovalMode;
  pending: ToolApproval[];
}
