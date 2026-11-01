import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  canRetryProvider,
  emptyReplyRecoveryMessages,
  interruptedResponseReport,
  isPrematureReasoningEcho,
} from './responsePolicy';

describe('provider recovery policy', () => {
  it('retries temporary failures, but not credentials, invalid requests, or arbitrary aborts', () => {
    expect(canRetryProvider(new DOMException('Timed out', 'TimeoutError'))).toBe(true);
    expect(canRetryProvider({ statusCode: 503 })).toBe(true);
    expect(canRetryProvider({ code: 'server_is_overloaded', isRetryable: false })).toBe(true);
    expect(canRetryProvider({ isRetryable: true })).toBe(true);
    for (const error of [
      null,
      { statusCode: 401 },
      { statusCode: 400 },
      new DOMException('', 'AbortError'),
    ])
      expect(canRetryProvider(error)).toBe(false);
  });
  it('reports uncertain actions without claiming they completed or exposing tool output', () => {
    const report = interruptedResponseReport([
      {
        id: '1',
        tool: 'terminal',
        action: 'run',
        path: '',
        summary: 'PRIVATE OUTPUT',
        status: 'complete',
      },
      { id: '2', tool: 'memory', action: 'add', path: '', summary: '', status: 'failed' },
      { id: '3', tool: 'terminal', action: 'run', path: '', summary: '', status: 'running' },
    ]);
    expect(report).toContain('1 tool operations completed; 1 failed; 1 interrupted or unresolved');
    expect(report).toContain('Verify unresolved operations');
    expect(report).not.toContain('PRIVATE OUTPUT');
  });
});

describe('premature reasoning echoes', () => {
  it.each([
    'Continue.',
    'Proceed with the changes.',
    "Let's continue the investigation. I need to check the logs.",
    'I need to investigate this further. Let me check the details.',
    'The file is present. Let me look at the project structure.',
    'I’ll verify the result.',
  ])('recognizes an exact echo announcing unfinished work: %s', (text) => {
    expect(isPrematureReasoningEcho('\n' + text, text + '\n')).toBe(true);
  });

  it.each([
    ['42', '42'],
    ['The update is complete.', 'The update is complete.'],
    ['Let me know if you need anything else.', 'Let me know if you need anything else.'],
    ['I need your approval before proceeding.', 'I need your approval before proceeding.'],
    ['Continue.', 'I will inspect the files.'],
    ['Continue.', undefined],
    ['', ''],
  ])('leaves valid answers and nonmatching reasoning alone', (text, reasoning) => {
    expect(isPrematureReasoningEcho(text!, reasoning)).toBe(false);
  });
});

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
