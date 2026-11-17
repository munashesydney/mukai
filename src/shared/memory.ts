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
  retryAt: number | null;
  retrying: boolean;
  canRetry: boolean;
}
export type { Episode, MemoryFact, MemoryGraph, RecallTrace };
export type MemoryFactDetails = {
  fact: MemoryFact;
  history: MemoryFact[];
};
export type MemoryBackup = {
  version: 1;
  facts: Pick<
    MemoryFact,
    'subject' | 'relation' | 'object' | 'text' | 'validFrom' | 'validTo' | 'state' | 'ownerId'
  >[];
};
export type MemoryImportResult = { imported: number; deduplicated: number; revived: number };
export const MEMORY_BACKUP_MAX_BYTES = 32 * 1024 * 1024;

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
  factsPage: { page: number; size: number; total: number };
  embedding: { status: 'unavailable' | 'loading' | 'ready'; model: string; error: string | null };
}
