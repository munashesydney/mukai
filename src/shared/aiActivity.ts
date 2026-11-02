export type AIWorkKind = 'chat' | 'pursuit' | 'memory' | 'compaction' | 'connection';
export interface AIWorkContext {
  workspaceId?: string;
  botId?: string;
  conversationId?: string;
  messageId?: string;
  kind: AIWorkKind;
}
export interface AIWork extends AIWorkContext {
  id: string;
  queuedAt: string;
  startedAt?: string;
  workspaceName: string;
}
export interface AIActivity {
  limit: number;
  running: AIWork[];
  queued: AIWork[];
  pursuitQueued?: AIWork[];
  pursuitRunning?: AIWork[];
  pursuitLimit?: number;
}
