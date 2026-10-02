export interface FileChangeSummary {
  id: string;
  messageId: string;
  path: string;
  kind: 'created' | 'edited';
  added: number | null;
  removed: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileChangeDetail extends FileChangeSummary {
  before: string | null;
  after: string;
  hunks: DiffHunk[] | null;
}

export interface FileMutationSnapshot {
  path: string;
  before: string | null;
  after: string;
}
