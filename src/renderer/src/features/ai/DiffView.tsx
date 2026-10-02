import { useMemo, useState } from 'react';
import type { DiffHunk } from '../../../../shared/fileChanges';

export function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  const [limit, setLimit] = useState(400);
  const rows = useMemo(
    () =>
      hunks.flatMap((hunk) => {
        let oldLine = hunk.oldStart,
          newLine = hunk.newStart;
        return [
          {
            kind: 'hunk',
            text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            oldLine: null,
            newLine: null,
          },
          ...hunk.lines.map((line) => {
            const marker = line[0];
            return {
              kind:
                marker === '+'
                  ? 'added'
                  : marker === '-'
                    ? 'removed'
                    : marker === '\\'
                      ? 'meta'
                      : 'context',
              text: line,
              oldLine: marker === '+' || marker === '\\' ? null : oldLine++,
              newLine: marker === '-' || marker === '\\' ? null : newLine++,
            };
          }),
        ];
      }),
    [hunks],
  );
  if (!rows.length)
    return <p className="diff-empty">No text lines changed. This file was created empty.</p>;
  return (
    <>
      <div className="diff-lines" role="region" aria-label="Unified file diff" tabIndex={0}>
        {rows.slice(0, limit).map((row, index) => (
          <div key={index} className={`diff-line diff-line--${row.kind}`}>
            <span className="diff-line-number">{row.oldLine}</span>
            <span className="diff-line-number">{row.newLine}</span>
            <code>{row.text}</code>
          </div>
        ))}
      </div>
      {rows.length > limit && (
        <button className="diff-show-more" type="button" onClick={() => setLimit(limit + 400)}>
          Show next {Math.min(rows.length - limit, 400)} lines ({rows.length - limit} remaining)
        </button>
      )}
    </>
  );
}
