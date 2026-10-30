import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ResponsePart } from '../../../../shared/ai';
import { ResponseActivity } from './ResponseActivity';
import type { ChatActivity } from '../../../../shared/ai';

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
  it('shows active delegated bots below a held response even after dispatch tools complete', () => {
    const activity: ChatActivity[] = [
      {
        id: 'dispatch',
        tool: 'manage_bot',
        action: 'send_message',
        path: 'Ada',
        status: 'complete',
        summary: 'Dispatched.',
        delegation: {
          botId: 'ada',
          botName: 'Ada',
          avatar: 'nova',
          conversationId: 'pair',
          requestId: 'child-request',
          mode: 'fire_and_forget',
          status: 'streaming',
        },
      },
      {
        id: 'waiting',
        tool: 'manage_bot',
        action: 'wait_for_bots',
        path: '',
        status: 'running',
        summary: 'Waiting.',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          status: 'streaming',
          activity,
          parts: activity.map((item) => ({
            id: item.id,
            type: 'tool' as const,
            activityId: item.id,
          })),
        },
      }),
    );
    expect(html).toContain('Waiting for bots');
    expect(html).toContain('aria-label="Ada is working"');
    expect(html).toContain('spawned-bot-name');
    expect(html).toContain('typing-dots');
  });
  it('keeps returned bot text in a preview disclosure and does not replay typing indicators on history', () => {
    const activity: ChatActivity = {
      id: 'reply',
      tool: 'manage_bot',
      action: 'receive_message',
      path: 'Ada',
      status: 'complete',
      summary: 'Verified result.\n\nMore detail.',
      delegation: {
        botId: 'ada',
        botName: 'Ada',
        conversationId: 'pair',
        requestId: 'child-request',
        status: 'complete',
      },
    };
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          activity: [activity],
          parts: [{ id: 'reply', type: 'tool', activityId: 'reply' }],
        },
      }),
    );
    expect(html).toContain('response-tool--reply');
    expect(html).toContain('response-bot-preview');
    expect(html).toContain('More detail.');
    expect(html).not.toContain('spawned-bot-name');
    expect(html).not.toContain('typing-dots');
  });
  it('keeps a running terminal collapsed and combines its process polls into one card', () => {
    const snapshot = {
      id: '68db9142-e774-4bdf-bbdb-1b95219dd12a',
      command: 'python report.py',
      cwd: '/workspace',
      shell: 'sh',
      status: 'running' as const,
      exitCode: null,
      createdAt: message.createdAt,
      output: 'Starting…',
    };
    const activity: ChatActivity[] = [
      {
        id: 'run',
        tool: 'terminal',
        action: 'run',
        path: snapshot.command,
        status: 'complete',
        summary: '',
        processSessionId: snapshot.id,
        terminal: snapshot,
      },
      {
        id: 'poll',
        tool: 'terminal',
        action: 'poll',
        path: snapshot.id,
        status: 'complete',
        summary: '',
        processSessionId: snapshot.id,
        terminal: { ...snapshot, output: 'Latest output <script>bad()</script>' },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          content: '',
          activity,
          parts: activity.map((item) => ({
            id: item.id,
            type: 'tool' as const,
            activityId: item.id,
          })),
        },
      }),
    );
    expect(html.match(/class="terminal-card"/g)).toHaveLength(1);
    expect(html).toContain('Running python report.py');
    expect(html).not.toContain('Latest output');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Success');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('terminal-panel');
  });
  it('groups mixed tools and intervening reasoning between text updates into collapsed one-liners', () => {
    const activities: ChatActivity[] = [
      { ...message.activity![0], id: 'read', path: 'src/app.ts' },
      {
        id: 'run',
        tool: 'terminal',
        action: 'run',
        path: 'npm test',
        status: 'complete',
        summary: 'Tests passed.',
      },
      { ...message.activity![0], id: 'next', path: 'src/useChatActivity.ts', status: 'running' },
    ];
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          status: 'streaming',
          activity: activities,
          parts: [
            { id: 'intro', type: 'text', text: 'I will inspect the code.' },
            { id: 'read', type: 'tool', activityId: 'read' },
            {
              id: 'reasoning',
              type: 'reasoning',
              text: 'Inspecting the tests.',
              state: 'complete',
            },
            { id: 'run', type: 'tool', activityId: 'run' },
            {
              id: 'update',
              type: 'text',
              text: 'The tests pass. Checking the activity view next.',
            },
            { id: 'next', type: 'tool', activityId: 'next' },
          ],
        },
      }),
    );
    expect(html.match(/class="response-tool-group"/g)).toHaveLength(2);
    expect(html).not.toContain('class="response-tool-group" open');
    expect(html).toContain('Read files, ran commands');
    expect(html).toContain('Reading useChatActivity.ts');
    expect(html.match(/class="response-tool-group-label is-working"/g)).toHaveLength(1);
    expect(html.indexOf('I will inspect the code.')).toBeLessThan(
      html.indexOf('Read files, ran commands'),
    );
    expect(html.indexOf('The tests pass.')).toBeLessThan(
      html.indexOf('Reading useChatActivity.ts'),
    );
  });
  it('replaces the live title with a summary when the next text block starts', () => {
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: { ...message, status: 'streaming' },
      }),
    );
    expect(html).toContain('response-tool-group-label');
    expect(html).toContain('Read files');
    expect(html).not.toContain('response-tool-group-label is-working');
    expect(html).toContain('response-shimmer');
    expect(html).not.toContain('typing-dots');
  });
  it('ignores newline-only provider text between tool calls in saved responses', () => {
    const activity: ChatActivity[] = [
      { ...message.activity![0], id: 'edit-1', action: 'patch' },
      { ...message.activity![0], id: 'edit-2', action: 'patch' },
      { ...message.activity![0], id: 'command-1', tool: 'terminal', action: 'run' },
      { ...message.activity![0], id: 'command-2', tool: 'terminal', action: 'run' },
    ];
    const parts: ResponsePart[] = [{ id: 'intro', type: 'text', text: 'Fixing the store.' }];
    activity.forEach((item, index) =>
      parts.push(
        { id: `tool-${index}`, type: 'tool', activityId: item.id },
        {
          id: `reasoning-${index}`,
          type: 'reasoning',
          text: 'Checking the next step.',
          state: 'complete',
        },
        { id: `separator-${index}`, type: 'text', text: index % 2 ? '\n\n\n' : ' \n\n' },
      ),
    );
    parts.push({ id: 'final', type: 'text', text: 'The store is fixed.' });
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: { ...message, activity, parts },
      }),
    );
    expect(html.match(/class="response-tool-group"/g)).toHaveLength(1);
    expect(html).toContain('Edited files, ran commands');
    expect(html).not.toMatch(/class="ai-markdown"><p>\s*<\/p>/);
  });
  it('stops shimmering tool groups when a final answer begins streaming', () => {
    const parts = message.parts!.map((part) =>
      part.type === 'text' && part.id === 'answer' ? { ...part, final: true } : part,
    );
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: { ...message, status: 'streaming', parts },
      }),
    );
    expect(html).not.toContain('response-tool-group-label is-working');
    expect(html).toMatch(/<\/details><div class="ai-markdown"><p>Final answer/);
  });
  it('puts even the first pending tool behind a collapsed shimmer disclosure', () => {
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          status: 'streaming',
          activity: [],
          parts: [{ id: 'pending', type: 'tool', activityId: 'pending' }],
        },
      }),
    );
    expect(html).toContain('<details class="response-tool-group">');
    expect(html).toContain('Calling tools');
    expect(html).toContain('response-tool-group-label is-working');
  });
  it('collapses terminal failures by default while keeping their failed command visible', () => {
    const activity: ChatActivity = {
      id: 'failed-run',
      tool: 'terminal',
      action: 'run',
      path: 'python broken.py',
      status: 'complete',
      summary: '',
      terminal: {
        id: '68db9142-e774-4bdf-bbdb-1b95219dd12a',
        command: 'python broken.py',
        cwd: '/workspace',
        status: 'exited',
        exitCode: 2,
        createdAt: message.createdAt,
        output: 'Cannot open file.',
      },
    };
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: {
          ...message,
          content: '',
          activity: [activity],
          parts: [{ id: 'tool', type: 'tool', activityId: activity.id }],
        },
      }),
    );
    expect(html).toContain('terminal-card--failed');
    expect(html).toContain('Failed python broken.py');
    expect(html).not.toContain('Cannot open file.');
    expect(html).not.toContain('terminal-panel');
    expect(html).toContain('aria-expanded="false"');
  });
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
    expect(finished).not.toContain('<details class="response-reasoning" open="">');
  });
  it('starts completed work collapsed with the final answer outside the disclosure', () => {
    const html = renderToStaticMarkup(createElement(ResponseActivity, { message }));
    expect(html).toContain('<details class="response-work">');
    expect(html).toContain('Worked for 1m 3s');
    expect(html).toMatch(/<\/details><div class="ai-markdown"><p>Final answer/);
    expect(html.indexOf('Progress')).toBeLessThan(html.indexOf('Provider reasoning'));
    expect(html.indexOf('Provider reasoning')).toBeLessThan(html.indexOf('notes.txt'));
  });
  it('shows live work in the same expandable disclosure with elapsed time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:02:31Z'));
    try {
      const html = renderToStaticMarkup(
        createElement(ResponseActivity, {
          message: { ...message, status: 'streaming' },
          workExpanded: true,
        }),
      );
      expect(html).toContain('<details class="response-work" open="">');
      expect(html).toContain('Working for 2m 31s');
      expect(html).not.toContain('Worked for');
      expect(html).toContain('response-reasoning');
      expect(html).toContain('response-tool');
      expect(html).not.toContain('reasoning-card');
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows the live disclosure before any activity arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(message.createdAt));
    try {
      const html = renderToStaticMarkup(
        createElement(ResponseActivity, {
          message: {
            ...message,
            status: 'streaming',
            startedAt: undefined,
            parts: [],
            activity: [],
            content: '',
          },
        }),
      );
      expect(html).toContain('<details class="response-work" open="">');
      expect(html).toContain('<summary><span>Working for 0s</span>');
      expect(html).toContain('class="response-tool-group-label is-working" role="status">Thinking');
    } finally {
      vi.useRealTimers();
    }
  });
  it('separates consecutive image views from ordinary tools on both sides', () => {
    const activity: ChatActivity[] = [
      { ...message.activity![0], id: 'read-before' },
      ...Array.from({ length: 3 }, (_, index): ChatActivity => ({
        id: `image-${index}`,
        tool: index === 1 ? 'image' : 'media',
        action: index === 1 ? 'view' : 'view_image',
        path: `image-${index}.png`,
        status: 'complete',
        summary: 'Viewed the image.',
      })),
      { ...message.activity![0], id: 'command-after', tool: 'terminal', action: 'run' },
    ];
    const parts: ResponsePart[] = [{ id: 'intro', type: 'text', text: 'Checking the layout.' }];
    activity.forEach((item, index) =>
      parts.push(
        { id: `tool-${index}`, type: 'tool', activityId: item.id },
        {
          id: `reasoning-${index}`,
          type: 'reasoning',
          text: 'Inspecting the next result.',
          state: 'complete',
        },
        { id: `separator-${index}`, type: 'text', text: '\n\n' },
      ),
    );
    parts.push({ id: 'final', type: 'text', text: 'The layout is checked.' });
    const html = renderToStaticMarkup(
      createElement(ResponseActivity, {
        message: { ...message, activity, parts },
      }),
    );
    expect(html.match(/class="response-tool-group"/g)).toHaveLength(3);
    expect(html).toContain('Viewed 3 images');
    expect(html.indexOf('Read files')).toBeLessThan(html.indexOf('Viewed 3 images'));
    expect(html.indexOf('Viewed 3 images')).toBeLessThan(html.indexOf('Ran commands'));
  });
  it.each([
    ['listen_audio', 'Listened to 2 audio clips', 'Listening to 2 audio clips'],
    ['view_video', 'Viewed 2 videos', 'Viewing 2 videos'],
    ['view_image', 'Viewed 2 images', 'Viewing 2 images'],
  ])(
    'counts %s calls in a dedicated completed and active media group',
    (action, completed, active) => {
      const activity: ChatActivity[] = [0, 1].map((index) => ({
        id: `media-${index}`,
        tool: 'media',
        action,
        path: `media-${index}`,
        status: 'complete',
        summary: '',
      }));
      const parts: ResponsePart[] = activity.map((item) => ({
        id: item.id,
        type: 'tool',
        activityId: item.id,
      }));
      const html = renderToStaticMarkup(
        createElement(ResponseActivity, {
          message: { ...message, activity, parts },
        }),
      );
      expect(html).toContain(completed);
      const streaming = renderToStaticMarkup(
        createElement(ResponseActivity, {
          message: {
            ...message,
            activity: activity.map((item) => ({ ...item, status: 'running' as const })),
            parts,
            status: 'streaming',
          },
        }),
      );
      expect(streaming).toContain(active);
      expect(streaming).toContain('response-tool-group-label is-working');
      expect(streaming).toContain('Working for');
    },
  );
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
