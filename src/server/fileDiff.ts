import { structuredPatch } from 'diff';
import type { DiffHunk } from '../shared/fileChanges';

export function fileDiff(path: string, before: string | null, after: string) {
  // Path names are display metadata; no Git checkout or current-file reads are involved.
  const patch = structuredPatch(path, path, before || '', after, undefined, undefined, {
    context: 3,
    timeout: 200,
    maxEditLength: 20000,
  });
  if (!patch) return { added: null, removed: null, hunks: null };
  let added = 0,
    removed = 0;
  for (const hunk of patch.hunks)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  return { added, removed, hunks: patch.hunks as DiffHunk[] };
}
