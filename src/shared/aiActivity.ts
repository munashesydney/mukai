export type AIWorkKind = 'chat' | 'pursuit' | 'memory' | 'compaction' | 'connection';
export interface AIWorkContext {
  providerId?: string;
  providerName?: string;
  memoryRetry?: { attempt: number; maxAttempts: number; phase: 'retry' | 'compaction' };
  workspaceId?: string;
  botId?: string;
  conversationId?: string;
  messageId?: string;
  kind: AIWorkKind;
}
export interface AIWork extends AIWorkContext {
  memoryPressure?: AIMemoryPressure;
  id: string;
  queuedAt: string;
  startedAt?: string;
  workspaceName: string;
}
export interface AIMemoryPressure {
  providerId: string;
  providerName: string;
  effectiveLimit: number;
  configuredLimit: number;
  cooldownUntil?: string;
}
export interface AIActivity {
  memoryPressure?: AIMemoryPressure[];
  limit: number;
  running: AIWork[];
  queued: AIWork[];
  pursuitQueued?: AIWork[];
  pursuitRunning?: AIWork[];
  pursuitLimit?: number;
}
