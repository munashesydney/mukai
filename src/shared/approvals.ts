export type ApprovalMode = 'ask-for-approval' | 'full-access';

export interface ToolApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  botId: string;
  botName: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
}

export interface ApprovalState {
  mode: ApprovalMode;
  pending: ToolApproval[];
}
