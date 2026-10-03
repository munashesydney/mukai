import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../../shared/ai';
import { ResponseActivity } from './ResponseActivity';

const message: ChatMessage = {
  id: 'response',
  requestId: 'request',
  botId: 'scout',
  role: 'assistant',
  content: 'Progress\n\nFinal answer',
  status: 'complete',
  error: null,
  createdAt: '2026-10-02T00:00:00Z',
  attachments: [],
  startedAt: '2026-10-02T00:00:00Z',
  finishedAt: '2026-10-02T00:01:03Z',
  activity: [
    {
      id: 'read',
      tool: 'file_operations',
      action: 'read_file',
      path: 'notes.txt',
      status: 'complete',
      summary: 'Read the notes.',
    },
  ],
  parts: [
    { id: 'progress', type: 'text', text: 'Progress' },
    { id: 'reasoning', type: 'reasoning', text: 'Provider reasoning' },
    { id: 'tool', type: 'tool', activityId: 'read' },
    { id: 'answer', type: 'text', text: 'Final answer' },
  ],
};
describe('Response activity disclosures', () => {
  it.each(['compacting', 'complete', 'failed', 'interrupted'] as const)(
    'shows an ordered %s context divider between activity and resumed work',
    (state) => {
      const parts: ChatMessage['parts'] = [
        { id: 'before', type: 'text', text: 'Before compaction' },
        {
          id: 'boundary',
          type: 'compaction',
          state,
          startedAt: message.createdAt,
          tokensBefore: 24000,
          tokensAfter: 5000,
        },
        { id: 'after', type: 'text', text: 'After compaction' },
      ];
      const html = renderToStaticMarkup(
        createElement(ResponseActivity, { message: { ...message, status: 'streaming', parts } }),
      );
      const label =
        state === 'compacting'
          ? 'Compacting context…'
          : state === 'complete'
            ? 'Context compacted'
            : state === 'failed'
              ? 'Context compaction failed'
              : 'Context compaction interrupted';
      expect(html).toContain(label);
      expect(html.indexOf('Before compaction')).toBeLessThan(html.indexOf('response-compaction'));
      expect(html.indexOf(label)).toBeLessThan(html.indexOf('After compaction'));
      expect(html).toContain('role="status"');
    },
  );
  it('shows a stale compaction as interrupted after the run ends', () => {
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          status: 'interrupted',
          parts: [
            {
              id: 'boundary',
              type: 'compaction',
              state: 'compacting',
              startedAt: message.createdAt,
              tokensBefore: 24000,
            },
          ],
        },
      }),
    );
    expect(html).toContain('Context compaction interrupted');
    expect(html).not.toContain('Compacting context…');
  });
  it('expands active reasoning and collapses it at reasoning-end while the response continues', () => {
    const thinking: ChatMessage = {
      ...message,
      status: 'streaming',
      parts: [
        {
          id: 'thinking',
          type: 'reasoning',
          text: 'Considering the next step.',
          state: 'streaming',
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(ResponseActivity, { message: thinking }));
    expect(html).toContain('<details class="response-reasoning" open="">');
    expect(html).toContain('Thinking');
    const finished = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...thinking,
          parts: [
            {
              id: 'thinking',
              type: 'reasoning',
              text: 'Considering the next step.',
              state: 'complete',
            },
          ],
        },
      }),
    );
    expect(finished).toContain('<details class="response-reasoning">');
    expect(finished).not.toContain('open=""');
  });
  it('starts completed work collapsed with the final answer outside the disclosure', () => {
    const html = renderToStaticMarkup(createElement(ResponseActivity, { message }));
    expect(html).toContain('<details class="response-work">');
    expect(html).toContain('Worked for 1m 3s');
    expect(html).toMatch(/<\/details><div class="ai-markdown"><p>Final answer/);
    expect(html.indexOf('Progress')).toBeLessThan(html.indexOf('Provider reasoning'));
    expect(html.indexOf('Provider reasoning')).toBeLessThan(html.indexOf('notes.txt'));
  });
  it('shows streaming activity inline without a completed work disclosure', () => {
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, { message: { ...message, status: 'streaming' } }),
    );
    expect(html).not.toContain('response-work');
    expect(html).toContain('response-reasoning');
    expect(html).toContain('response-tool');
    expect(html).not.toContain('reasoning-card');
  });
  it('keeps failed tool output and stopped response status visible on expansion', () => {
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          status: 'stopped',
          activity: [{ ...message.activity![0], status: 'failed', summary: 'Permission denied.' }],
        },
      }),
    );
    expect(html).toContain('Stopped for 1m 3s');
    expect(html).toContain('Failed: read file');
    expect(html).toContain('Permission denied.');
  });
});
