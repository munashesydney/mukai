import type { Episode, MemoryFact, MemoryGraph, RecallTrace } from '../../mukai_memory/src/types';
export type { Episode, MemoryFact, MemoryGraph, RecallTrace };

export interface MemorySettings {
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
  totalFacts: number;
  embedding: { status: 'unavailable' | 'loading' | 'ready'; model: string; error: string | null };
}
