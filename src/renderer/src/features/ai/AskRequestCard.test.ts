import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolApproval } from '../../../../shared/approvals';
import { AskRequestCard } from './AskRequestCard';

const request: ToolApproval = {
  id: 'question',
  toolCallId: 'call',
  toolName: 'ask',
  input: {},
  botId: 'bot',
  botName: 'Mukai',
  conversationId: 'chat',
  messageId: 'message',
  batchId: 'batch',
  createdAt: '2026-10-04T00:00:00Z',
  ask: {
    action: 'clarification',
    question: 'Which audience?',
    options: [
      { label: 'New customers', description: 'Reach a new audience.', recommended: true },
      { label: 'Existing customers', recommended: false },
    ],
  },
};
describe('Ask request cards', () => {
  it('shows suggestions, one recommendation and a free-text answer without preselecting it', () => {
    const html = renderToStaticMarkup(createElement(AskRequestCard, { request, busy: false }));
    expect(html).toContain('Which audience?');
    expect(html).toContain('Reach a new audience.');
    expect(html.match(/class="ask-recommended"/g)).toHaveLength(1);
    expect(html).toContain('Type your answer');
    expect(html).toContain('Submit');
    expect(html).toContain('Skip');
    expect(html.match(/class="ask-option-number"/g)).toHaveLength(3);
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('Approve tool call');
  });
  it('offers immediate approve/deny and an optional denial reason for an explicit approval', () => {
    const html = renderToStaticMarkup(
      createElement(AskRequestCard, {
        request: { ...request, ask: { action: 'approval', question: 'Publish this?' } },
        busy: true,
      }),
    );
    expect(html).toContain('Publish this?');
    expect(html).toContain('>Approve</button>');
    expect(html).toContain('>Deny</button>');
    expect(html).toContain('>Deny with reason</button>');
    expect(html).not.toContain('<textarea');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
