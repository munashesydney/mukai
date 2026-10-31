import type { AskInput } from './ask';
import type { CustomToolPresentation } from './customCapabilities';

export type ApprovalMode = 'ask-for-approval' | 'full-access';
export type ApprovalDecision = boolean | { approved: false; reason: string };

export interface ApprovalTarget {
  kind: 'private' | 'space' | 'pursuit_run' | 'bot';
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
  /** Snapshot of the custom tool's approval layout when this call was requested. */
  presentation?: CustomToolPresentation;
  botId: string;
  botName: string;
  conversationId: string;
  messageId: string;
  /** Calls emitted in the same model step share one approval group. */
  batchId: string;
  createdAt: string;
  target?: ApprovalTarget;
  /** Explicit human interaction, rather than permission to run a tool. */
  ask?: AskInput;
  /** Ancestor responses waiting for the bot making this request. */
  blockedParents?: { messageId: string; conversationId: string; botId: string; botName: string }[];
}

export function approvalBlocksConversation(request: ToolApproval, conversationId: string) {
  return (
    request.conversationId === conversationId ||
    Boolean(request.blockedParents?.some((parent) => parent.conversationId === conversationId))
  );
}

export interface ApprovalState {
  mode: ApprovalMode;
  pending: ToolApproval[];
}
