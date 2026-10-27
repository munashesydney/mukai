import { describe, expect, it } from 'vitest';
import type { ChatActivity, ChatMessage } from '../../../../shared/ai';
import { responseStatus } from './responseStatus';

const message: ChatMessage = {
  id: 'parent',
  botId: 'scout',
  requestId: 'request',
  role: 'assistant',
  content: 'Earlier progress',
  status: 'streaming',
  error: null,
  createdAt: '2026-10-27T00:00:00Z',
  attachments: [],
  parts: [{ id: 'old', type: 'text', text: 'Earlier progress' }],
};
const activity = (tool: string, action: string): ChatActivity => ({
  id: action,
  tool,
  action,
  path: '',
  status: 'running',
  summary: '',
});

describe('Live response status', () => {
  it.each([
    ['file_operations', 'write_file', 'Writing a file'],
    ['file_operations', 'patch', 'Editing a file'],
    ['file_operations', 'read_file', 'Reading a file'],
    ['terminal', 'run', 'Running a command'],
    ['manage_bot', 'create', 'Creating a bot'],
    ['manage_bot', 'send_message', 'Delegating to a bot'],
    ['manage_bot', 'wait_for_bots', 'Waiting for bots'],
    ['browser', 'navigate', 'Using the browser'],
    ['custom_tool', 'run', 'Calling tools'],
  ])('reports %s/%s while tools run after earlier text', (tool, action, expected) => {
    expect(responseStatus({ ...message, activity: [activity(tool, action)] })).toBe(expected);
  });
  it('switches from completed tools to thinking and then to fresh response text', () => {
    const tool = { ...activity('terminal', 'run'), status: 'complete' as const };
    const thinking: ChatMessage = {
      ...message,
      activity: [tool],
      parts: [...message.parts!, { id: 'command', type: 'tool', activityId: tool.id }],
    };
    expect(responseStatus(thinking)).toBe('Thinking');
    expect(
      responseStatus({
        ...thinking,
        parts: [...thinking.parts!, { id: 'answer', type: 'text', text: 'Result' }],
      }),
    ).toBe('Responding');
  });
  it('keeps waiting when one reply arrives while other bots are still running', () => {
    expect(
      responseStatus({
        ...message,
        activity: [
          activity('manage_bot', 'wait_for_bots'),
          { ...activity('manage_bot', 'receive_message'), status: 'complete' },
        ],
        parts: [{ id: 'reply', type: 'tool', activityId: 'receive_message' }],
      }),
    ).toBe('Waiting for bots');
  });
  it('keeps responding when an asynchronous bot reply arrives during response text', () => {
    expect(
      responseStatus({
        ...message,
        activity: [{ ...activity('manage_bot', 'receive_message'), status: 'complete' }],
        parts: [...message.parts!, { id: 'reply', type: 'tool', activityId: 'receive_message' }],
      }),
    ).toBe('Responding');
  });
});
