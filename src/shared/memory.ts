import type { Episode, MemoryFact, MemoryGraph, RecallTrace } from '../../mukai_memory/src/types';
import type { ChatActivity } from './ai';
export interface MemoryReviewRun {
  id: string;
  conversationId: string;
  conversationName: string;
  kind: string;
  ownerId: string | null;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  error: string | null;
  episodeId: string;
  messageIds: string[];
  activity: ChatActivity[];
}
export type { Episode, MemoryFact, MemoryGraph, RecallTrace };

export interface MemorySettings {
  enabled: boolean;
  automaticCapture: boolean;
  automaticRecall: boolean;
  semanticSearch: boolean;
  contextTokens: number;
}
export interface MemorySnapshot {
  settings: MemorySettings;
  facts: MemoryFact[];
  episodes: Episode[];
  graph: MemoryGraph;
  recalls: RecallTrace[];
  runs: MemoryReviewRun[];
  totalFacts: number;
  embedding: { status: 'unavailable' | 'loading' | 'ready'; model: string; error: string | null };
}
