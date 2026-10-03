export interface MemoryScope {
  workspaceId: string;
  privateOwner?: string;
  /** Host-authorized inspector only; never enable for agent recall. */
  includePrivate?: boolean;
}
export interface EpisodeInput {
  workspaceId: string;
  ownerId?: string | null;
  actorId?: string | null;
  sourceKey: string;
  sourceType: 'user' | 'tool' | 'manual' | 'correction' | 'import';
  content: string;
  referenceTime: string;
  conversationId?: string | null;
  messageId?: string | null;
  context?: string;
}
export interface Episode extends EpisodeInput {
  id: string;
  createdAt: string;
  status: 'pending' | 'processing' | 'complete' | 'failed' | 'forgotten';
  attempts: number;
  error: string | null;
}
export interface MemoryFact {
  id: string;
  workspaceId: string;
  ownerId: string | null;
  subjectId: string;
  subject: string;
  relation: string;
  objectId: string;
  object: string;
  text: string;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  supersededBy: string | null;
  state: 'confirmed' | 'uncertain';
  sources: Episode[];
}
export interface ExtractedFact {
  subject: string;
  subjectType: string;
  subjectAliases: string[];
  relation: string;
  object: string;
  objectType: string;
  objectAliases: string[];
  text: string;
  validFrom: string | null;
  validTo: string | null;
  disposition: 'assert' | 'replace' | 'uncertain';
  supersedes: string[];
}
export interface ExtractionRequest {
  episode: Episode;
  candidates: MemoryFact[];
  signal?: AbortSignal;
}
export type Extractor = (request: ExtractionRequest) => Promise<{ facts: ExtractedFact[] }>;
export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
  dispose?(): Promise<void>;
}
export interface SearchOptions {
  limit?: number;
  asOf?: string;
  includeHistory?: boolean;
  includeUncertain?: boolean;
}
export interface SearchHit {
  fact: MemoryFact;
  score: number;
  reasons: string[];
}
export interface MemoryGraph {
  nodes: { id: string; name: string; type: string; ownerId: string | null }[];
  edges: MemoryFact[];
  truncated: boolean;
}
export interface RecallTrace {
  id: string;
  createdAt: string;
  conversationId: string;
  messageId: string;
  query: string;
  facts: { id: string; text: string; reasons: string[] }[];
  characters: number;
}
