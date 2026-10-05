import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { emptyReplyRecoveryMessages } from './responsePolicy';

describe('empty reply continuation', () => {
  it('preserves answers and call/result pairs, with a fresh instruction after them', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Call ask and wait; do not provide a normal reply instead.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '',
            providerOptions: { openai: { itemId: 'rs_old', reasoningEncryptedContent: 'opaque' } },
          },
          { type: 'text', text: 'I will ask.' },
          {
            type: 'tool-call',
            toolCallId: 'call_ask',
            toolName: 'ask',
            input: { question: 'What are you looking forward to?' },
            providerOptions: { openai: { namespace: 'mukai' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_ask',
            toolName: 'ask',
            output: { type: 'text', value: '{"answer":"Time to relax"}' },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
    ];
    const original = structuredClone(messages);
    const recovery = emptyReplyRecoveryMessages(messages);
    expect(messages).toEqual(original);
    expect(recovery.slice(0, -1)).toEqual([
      messages[0],
      { ...messages[1], content: (messages[1].content as unknown[]).slice(1) },
      messages[2],
    ]);
    expect(recovery.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('not a new message from the human'),
    });
    expect(JSON.stringify(recovery)).not.toContain('opaque');
    expect(JSON.stringify(recovery)).toContain('Time to relax');
    expect(emptyReplyRecoveryMessages(messages)).toEqual(recovery);
  });

  it('requests an honest report when there are no successful tool results', () => {
    const recovery = emptyReplyRecoveryMessages([{ role: 'user', content: 'Do the work.' }]);
    expect(recovery[0]).toEqual({ role: 'user', content: 'Do the work.' });
    expect(recovery.at(-1)?.content).toContain('failures or unfinished work accurately');
  });
});
