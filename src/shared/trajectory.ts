export interface TrajectoryRecord {
  id: number;
  messageId: string;
  kind: 'model' | 'tool';
  title: string;
  status: 'running' | 'complete' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  firstTokenAt?: number;
  stepId?: number;
  callId?: string;
  parentCallId?: string;
  partIds?: string[];
  preview?: string;
  systemKey?: string;
  systemPreview?: string;
  contextPreviews?: string[];
  usage?: { input?: number; output?: number; cached?: number; reasoning?: number };
}

export interface TrajectoryDetail {
  system?: string;
  context?: string[];
  input?: string;
  output?: string;
  reasoning?: string;
  error?: string;
  schema?: { description?: string; parameters: string };
}
