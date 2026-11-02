import { expect, it } from 'vitest';
import { isProviderMemoryError, MemoryRecoveryExhaustedError } from './memoryRecovery';
import { isContextOverflow, safeProviderError } from './providerService';

it('recognizes typed HTTP, stream and wrapped memory errors without treating them as token overflow', () => {
  for (const error of [
    { code: 'prefill_memory_exceeded' },
    { name: 'AI_StreamProviderError', code: 'generation_memory_guard' },
    {
      cause: {
        lastError: {
          responseBody: JSON.stringify({ error: { code: 'memory_admission_stalled' } }),
        },
      },
    },
    {
      statusCode: 400,
      message: 'oMLX prefill memory guard rejected this prompt; reduce context length.',
    },
  ]) {
    expect(isProviderMemoryError(error)).toBe(true);
    expect(isContextOverflow(error)).toBe(false);
    expect(safeProviderError(error)).toContain('available memory');
  }
  expect(
    safeProviderError(new MemoryRecoveryExhaustedError({ code: 'prefill_memory_exceeded' })),
  ).toContain('bounded automatic recovery');
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  for (const error of [
    cycle,
    new Error('Tool file contains prefill_memory_exceeded'),
    { statusCode: 400, message: 'maximum context length exceeded' },
    { statusCode: 401, message: 'Invalid key' },
  ])
    expect(isProviderMemoryError(error)).toBe(false);
});
