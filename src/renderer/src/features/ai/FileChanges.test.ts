import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../../shared/ai';
import { FileChanges } from './FileChanges';
import { DiffView } from './DiffView';

const message: ChatMessage = {
  id: 'turn',
  botId: 'bot',
  requestId: 'request',
  role: 'assistant',
  status: 'complete',
  content: 'Done',
  error: null,
  createdAt: '2026-10-02',
  attachments: [],
  changes: Array.from({ length: 5 }, (_, index) => ({
    id: `change-${index}`,
    messageId: 'turn',
    path: `file-${index}.ts`,
    kind: 'edited',
    added: index + 1,
    removed: index,
  })),
};
describe('File changes review', () => {
  it('shows completed summaries, aggregate counts, three files, and an overflow control without Undo', () => {
    const html = renderToStaticMarkup(createElement(FileChanges, { message, onReview: () => {} }));
    expect(html).toContain('Edited 5 files');
    expect(html).toContain('15 lines added, 10 lines removed');
    expect(html).toContain('View changes');
    expect(html).toContain('Show 2 more files');
    expect(html).toContain('Review file-2.ts');
    expect(html).not.toContain('file-3.ts');
    expect(html).not.toContain('Undo');
  });
  it('does not show a card while streaming or when nothing changed', () => {
    expect(
      renderToStaticMarkup(
        createElement(FileChanges, {
          message: { ...message, status: 'streaming' },
          onReview: () => {},
        }),
      ),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        createElement(FileChanges, { message: { ...message, changes: [] }, onReview: () => {} }),
      ),
    ).toBe('');
  });
  it('escapes file contents in unified diffs and includes old/new line numbers', () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, {
        hunks: [
          {
            oldStart: 4,
            oldLines: 1,
            newStart: 4,
            newLines: 1,
            lines: ['-old', '+<script>alert(1)</script>'],
          },
        ],
      }),
    );
    expect(html).toContain('diff-line--removed');
    expect(html).toContain('diff-line--added');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('diff-line-number">4');
  });
});
