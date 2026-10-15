import { expect, it } from 'vitest';
import type { Bot, ChatMessage } from '../../../../shared/ai';
import { chatActivityData } from './chatActivityData';
const message = (id: string, status: ChatMessage['status'] = 'complete'): ChatMessage => ({
  id,
  requestId: id,
  botId: 'main',
  role: 'assistant',
  content: '',
  status,
  error: null,
  createdAt: '',
  attachments: [],
});
it('keeps discoveries across turns and deduplicates files and delegated conversations', () => {
  const a = message('a'),
    b = message('b'),
    running = message('c', 'streaming');
  a.changes = [
    { id: 'first', messageId: 'a', path: 'app.ts', kind: 'edited', added: 3, removed: 1 },
  ];
  b.changes = [{ ...a.changes[0], id: 'latest', messageId: 'b', added: 5 }];
  running.changes = [{ ...a.changes[0], id: 'not-yet', path: 'pending.ts' }];
  const delegation = { botId: 'child', botName: 'Ada', conversationId: 'pair', requestId: 'one' };
  a.activity = [
    {
      id: 'call',
      tool: 'manage_bot',
      action: 'send_message',
      status: 'complete',
      path: '',
      summary: '',
      delegation,
    },
    {
      id: 'create',
      tool: 'manage_bot',
      action: 'create',
      status: 'complete',
      path: '',
      summary: '',
      createdBotId: 'child',
    },
  ];
  b.activity = [{ ...a.activity[0], delegation: { ...delegation, requestId: 'two' } }];
  const data = chatActivityData([a, b, running], [], [], [{ id: 'child' } as Bot]);
  expect(data.changes.map((item) => item.id)).toEqual(['latest', 'not-yet']);
  expect(data.delegated).toEqual([{ ...delegation, requestId: 'two' }]);
  expect(data.spawned).toEqual([]);
  expect(data.count).toBe(3);
});
it('reveals registered outputs during a turn without interpreting assistant prose as links', () => {
  const running = { ...message('a', 'streaming'), content: 'Started http://localhost:3000' };
  const output = {
    id: 'out',
    botId: 'main',
    messageId: 'a',
    sessionId: 'session',
    url: 'http://localhost:3000/',
    computer: 'local' as const,
    status: 'running' as const,
  };
  expect(chatActivityData([running], [output], [], []).count).toBe(1);
  expect(chatActivityData([{ ...running, status: 'complete' }], [output], [], []).count).toBe(1);
  expect(chatActivityData([{ ...running, status: 'complete' }], [], [], []).count).toBe(0);
});

it('includes saved artifacts and delegations before the response finishes', () => {
  const running = message('live', 'streaming');
  running.activity = [
    {
      id: 'delegate',
      tool: 'bots',
      action: 'send_message',
      path: '',
      summary: '',
      status: 'running',
      delegation: { botId: 'child', botName: 'Ada', conversationId: 'pair', requestId: 'request' },
    },
  ];
  const artifact = {
    id: 'file',
    messageId: 'live',
    botId: 'main',
    path: 'draft.md',
    name: 'draft.md',
    createdAt: '',
  };
  const data = chatActivityData([running], [], [artifact], []);
  expect(data.artifacts).toEqual([artifact]);
  expect(data.delegated).toEqual([running.activity[0].delegation]);
  expect(data.count).toBe(2);
  expect(chatActivityData([message('other')], [], [artifact], []).count).toBe(0);
});
