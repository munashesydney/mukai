import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage } from '../../../../shared/ai';
import { SteeringMessages } from './SteeringMessages';
import { ResponseActivity } from './ResponseActivity';

const message: ChatMessage = {
  id: 'assistant',
  requestId: 'request',
  botId: 'scout',
  role: 'assistant',
  status: 'complete',
  error: null,
  createdAt: '2026-10-12T17:00:00Z',
  attachments: [],
  content: 'Completed both tasks.',
  parts: [
    { id: 'before', type: 'text', text: 'Earlier work' },
    {
      id: 'steer',
      type: 'steering',
      text: 'Also multiply two numbers.',
      createdAt: '2026-10-12T17:02:00Z',
    },
    {
      id: 'second',
      type: 'steering',
      text: 'Keep the weather tool too.',
      createdAt: '2026-10-12T17:03:00Z',
    },
    { id: 'answer', type: 'text', text: 'Completed both tasks.' },
  ],
};

it('shows collapsed steering as user messages with their own times and icons after the times', () => {
  const html = renderToStaticMarkup(createElement(SteeringMessages, { message, collapsed: true }));
  expect(html.match(/ai-message--steering/g)).toHaveLength(2);
  expect(html).toContain('<strong>You</strong>');
  expect(html).toContain('dateTime="2026-10-12T17:02:00Z"');
  expect(html).toMatch(/<\/time><svg[^>]*aria-label="Steered this task"/);
  expect(html.indexOf('Also multiply')).toBeLessThan(html.indexOf('Keep the weather'));
});

it('keeps the expanded transcript unchanged and hides the separate user messages', () => {
  expect(renderToStaticMarkup(createElement(SteeringMessages, { message, collapsed: false }))).toBe(
    '',
  );
  const html = renderToStaticMarkup(
    createElement(ResponseActivity, { message, workExpanded: true }),
  );
  expect(html).toContain('<details class="response-work" open="">');
  expect(html).toContain('You steered this task');
  expect(html.indexOf('Earlier work')).toBeLessThan(html.indexOf('Also multiply'));
  expect(html).toMatch(/<\/details><div class="ai-markdown"><p>Completed both tasks/);
});

it('shows active steering when work is collapsed and uses the message time for legacy parts', () => {
  expect(
    renderToStaticMarkup(
      createElement(SteeringMessages, {
        message: { ...message, status: 'streaming' },
        collapsed: true,
      }),
    ),
  ).toContain('Also multiply two numbers.');
  const html = renderToStaticMarkup(
    createElement(SteeringMessages, {
      message: {
        ...message,
        parts: [{ id: 'legacy', type: 'steering', text: 'Legacy correction' }],
      },
      collapsed: true,
    }),
  );
  expect(html).toContain('dateTime="2026-10-12T17:00:00Z"');
});
