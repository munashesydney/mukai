import { describe, expect, it } from 'vitest';
import {
  providerToolCallFailure,
  providerToolCallFeedback,
  providerToolCallStep,
} from './providerToolCallRecovery';
import type { ModelMessage } from 'ai';
import type { ApprovalStepCall } from '../repositories/chatJobRepository';

describe('provider tool-call feedback', () => {
  it('recognizes structured stream errors and nested HTTP errors', () => {
    expect(providerToolCallFailure({ code: 'invalid_tool_call', isRetryable: false })).toBe(
      'invalid_tool_call',
    );
    expect(
      providerToolCallFailure({
        cause: {
          lastError: {
            responseBody: JSON.stringify({ error: { code: 'incomplete_tool_call' } }),
          },
        },
      }),
    ).toBe('incomplete_tool_call');
    expect(providerToolCallFailure({ data: { error: { code: 'invalid_tool_call' } } })).toBe(
      'invalid_tool_call',
    );
  });
  it('does not repair credentials, rate limits, arbitrary prose, or circular chains', () => {
    for (const statusCode of [401, 402, 403, 404, 429])
      expect(
        providerToolCallFailure({ statusCode, cause: { code: 'invalid_tool_call' } }),
      ).toBeUndefined();
    expect(providerToolCallFailure(new Error('invalid_tool_call PRIVATE_CONTENT'))).toBeUndefined();
    expect(providerToolCallFailure({ responseBody: 'invalid_tool_call' })).toBeUndefined();
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(providerToolCallFailure(cycle)).toBeUndefined();
  });
  it('explains both failure types and preserves execution and authorization boundaries', () => {
    for (const code of ['invalid_tool_call', 'incomplete_tool_call'] as const) {
      const feedback = providerToolCallFeedback(code);
      expect(feedback).toContain(code);
      expect(feedback).toContain('not a new message from the human');
      expect(feedback).toContain('was not executed by Mukai');
      expect(feedback).toContain('Do not repeat completed calls');
      expect(feedback).toContain('inspect the affected state');
      expect(feedback).toContain('declared argument schema');
    }
  });
});

describe('failed provider step receipts', () => {
  const call: ApprovalStepCall = {
    toolCallId: 'write',
    toolName: 'file_operations',
    input: { action: 'write_file', path: 'once.txt' },
    batchId: 'batch',
    state: 'resolved',
    output: { type: 'text', value: 'Already written.' },
  };
  const partial: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Private reasoning',
          providerOptions: { openai: { reasoningEncryptedContent: 'opaque' } },
        },
        { type: 'text', text: 'Fixing the remaining defect.' },
        { type: 'tool-call', toolCallId: 'write', toolName: 'file_operations', input: call.input },
      ],
    },
  ];
  it('restores a missing SDK result from the saved execution journal without executing it', () => {
    const recovery = providerToolCallStep(partial, [call])!;
    expect(recovery).toHaveLength(2);
    expect(recovery[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'write',
          toolName: 'file_operations',
          output: call.output,
        },
      ],
    });
    expect(JSON.stringify(recovery)).not.toMatch(/opaque|Private reasoning/);
    expect(JSON.stringify(recovery)).toContain('Fixing the remaining defect.');
  });
  it('refuses to turn an unresolved operation into a successful or unexecuted receipt', () => {
    for (const state of ['pending', 'running'] as const)
      expect(
        providerToolCallStep(partial, [{ ...call, state, output: undefined }]),
      ).toBeUndefined();
  });
  it('explains undispatched calls and preserves a failed result that the SDK already recorded', () => {
    expect(JSON.stringify(providerToolCallStep(partial, []))).toContain(
      'failed before Mukai dispatched it',
    );
    const error: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'write',
          toolName: 'file_operations',
          output: { type: 'error-text', value: 'The write failed. Inspect the file.' },
        },
      ],
    };
    expect(providerToolCallStep([...partial, error], [])?.at(-1)).toEqual(error);
  });
});
