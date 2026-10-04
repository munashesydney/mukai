import { describe, expect, it } from 'vitest';
import type { ToolApproval } from '../../../../shared/approvals';
import { approvalLocation } from './approvalLocation';

const request: ToolApproval = {
  id: 'a',
  toolCallId: 'c',
  toolName: 'browser',
  input: {},
  botId: 'bot',
  botName: 'Mukai',
  conversationId: 'exact-chat',
  messageId: 'm',
  batchId: 'batch',
  createdAt: '2026-10-04T00:00:00Z',
};
describe('Pending approval destinations', () => {
  it('opens the exact private chat rather than the bot’s latest chat', () => {
    expect(approvalLocation(request)).toEqual({
      section: 'bots',
      item: 'bot',
      conversationId: 'exact-chat',
    });
  });
  it('opens the originating shared space', () => {
    expect(
      approvalLocation({
        ...request,
        target: { kind: 'space', workspaceId: 'default', name: 'Team' },
      }),
    ).toEqual({ section: 'spaces', item: 'exact-chat' });
  });
  it('opens the exact pursuit run rather than its overview or latest run', () => {
    expect(
      approvalLocation({
        ...request,
        target: {
          kind: 'pursuit_run',
          workspaceId: 'default',
          name: 'Research',
          pursuitId: 'pursuit',
          runId: 'run',
        },
      }),
    ).toEqual({ section: 'pursuits', item: 'pursuit', runId: 'run', conversationId: 'exact-chat' });
  });
});
