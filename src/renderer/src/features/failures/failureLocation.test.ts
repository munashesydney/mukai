import { describe, it, expect } from 'vitest';
import type { ChatFailure } from '../../../../shared/failures';
import { failureLocation } from './failureLocation';
const notice: ChatFailure = {
  id: 'chat',
  workspaceId: 'other',
  workspaceName: 'Other workspace',
  botName: 'Nova',
  failedAt: '2026-11-02T00:00:00Z',
  error: 'Disconnected',
  conversation: {
    id: 'chat',
    workspaceId: 'other',
    kind: 'private',
    name: 'Task',
    description: '',
    botIds: ['owner'],
    ownerBotId: 'owner',
    createdAt: '',
    updatedAt: '',
  },
};
describe('failure navigation', () => {
  it('opens the exact original private conversation', () =>
    expect(failureLocation(notice)).toEqual({
      section: 'bots',
      item: 'owner',
      conversationId: 'chat',
    }));
  it('opens a shared space', () =>
    expect(
      failureLocation({ ...notice, conversation: { ...notice.conversation, kind: 'space' } }),
    ).toEqual({ section: 'spaces', item: 'chat' }));
  it('opens bot-to-bot conversations', () =>
    expect(
      failureLocation({ ...notice, conversation: { ...notice.conversation, kind: 'bot' } }),
    ).toEqual({ section: 'bots', item: 'bot-conversations', conversationId: 'chat' }));
  it('opens the exact pursuit run rather than starting a fresh one', () =>
    expect(
      failureLocation({
        ...notice,
        pursuitId: 'pursuit',
        runId: 'run',
        conversation: { ...notice.conversation, kind: 'pursuit_run' },
      }),
    ).toEqual({ section: 'pursuits', item: 'pursuit', runId: 'run' }));
});
