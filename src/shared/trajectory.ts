export type TrajectoryContextKind = 'retrieved-memory' | 'working-memory' | 'runtime';

export const retrievedMemoryPrefix = 'Retrieved memory reference data.';
export const workingMemoryPrefix = 'Working memory from earlier activity';

export function trajectoryContextKind(text: string): TrajectoryContextKind {
  if (text.startsWith(retrievedMemoryPrefix)) return 'retrieved-memory';
  if (text.startsWith(workingMemoryPrefix)) return 'working-memory';
  return 'runtime';
}

const contextPreviewLimit = 240;

export function trajectoryContextPreview(
  text: string,
  kind: TrajectoryContextKind,
  redact: (value: string) => string,
): string {
  if (kind === 'retrieved-memory') {
    const facts = text
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        if (!line.startsWith('{')) return [];
        try {
          const { fact } = JSON.parse(line);
          return typeof fact === 'string' && fact.trim()
            ? [redact(fact).replace(/\s+/g, ' ').trim()]
            : [];
        } catch {
          return [];
        }
      });
    if (!facts.length) return 'Open to see the retrieved memory sent to the model.';
    const label = facts.length === 1 ? '1 fact' : `${facts.length} facts`;
    const excerpts = facts
      .slice(0, 3)
      .map((fact) => (fact.length > 70 ? fact.slice(0, 69) + '…' : fact));
    return `${label} · ${excerpts.join(' · ')}`;
  }
  if (kind === 'working-memory') {
    const marker = '<working-memory>';
    const start = text.indexOf(marker);
    if (start >= 0)
      return text
        .slice(start + marker.length)
        .split('</working-memory>')[0]
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, contextPreviewLimit);
  }
  return text.slice(0, contextPreviewLimit);
}

export interface TrajectoryRecord {
  id: number;
  messageId: string;
  kind: 'model' | 'tool';
  title: string;
  status: 'running' | 'complete' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  modelStepId?: string;
  stepId?: number;
  callId?: string;
  parentCallId?: string;
  partIds?: string[];
  preview?: string;
  systemKey?: string;
  systemPreview?: string;
  contextPreviews?: string[];
  contextKinds?: TrajectoryContextKind[];
  usage?: { input?: number; output?: number; cached?: number; reasoning?: number };
}

export interface TrajectoryMessageStats {
  messageId: string;
  steps: number;
  input?: number;
  output?: number;
  cached: number;
  cacheInput: number;
  timedOutput: number;
  decodeMs: number;
  speedEstimated: boolean;
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
