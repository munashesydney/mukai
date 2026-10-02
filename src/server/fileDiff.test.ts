import { describe, expect, it } from 'vitest';
import { applyPatch } from 'diff';
import { fileDiff } from './fileDiff';

describe('Saved line diffs', () => {
  it.each([
    ['new.ts', null, 'one\ntwo\n', 2, 0],
    ['edit.ts', 'first\nold\nlast\n', 'first\nnew\nlast\n', 1, 1],
    ['empty.ts', null, '', 0, 0],
    ['blank.ts', 'line\n\n', 'line\n', 0, 1],
    ['newline.ts', 'line', 'line\n', 1, 1],
    ['crlf.ts', 'first\r\nold\r\n', 'first\r\nnew\r\n', 1, 1],
  ] as const)(
    'computes exact counts and a reconstructable patch for %s',
    (path, before, after, added, removed) => {
      const result = fileDiff(path, before, after);
      expect(result).toMatchObject({ added, removed });
      expect(
        applyPatch(before || '', {
          oldFileName: path,
          newFileName: path,
          oldHeader: undefined,
          newHeader: undefined,
          hunks: result.hunks!,
        }),
      ).toBe(after);
    },
  );
});
