import { afterEach, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import type { ProviderService } from './providerService';
import { contextSummarizer } from './contextSummary';
import { AIConcurrency } from './aiConcurrency';
vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: vi.fn(),
}));
const generate = vi.mocked(generateText);
const item = (sourceId: string, note: string, quote: string) => ({
  section: 'context',
  note,
  sources: [{ sourceId, quote }],
});
const config = {
  ai: new AIConcurrency(),
  aiContext: {},
  provider: { kind: 'compatible' },
  modelId: 'fixture',
  model: {},
  contextWindow: 16384,
  maxOutputTokens: 2048,
} as unknown as ReturnType<ProviderService['resolve']>;
function result(text: string) {
  return { text, finishReason: 'stop', usage: { totalTokens: 10 } } as Awaited<
    ReturnType<typeof generateText>
  >;
}
const input = `<previous-summary>\n\n</previous-summary>\n<historical-data>\n${JSON.stringify({ origin: 'assistant_report', text: 'Possible VM rollback; unverified.' })}\n</historical-data>`;
afterEach(() => vi.restoreAllMocks());
it('requests a task handover with connected evidence and keeps it structured for the next compaction', async () => {
  generate.mockReset();
  generate.mockResolvedValue(
    result(
      JSON.stringify([
        {
          section: 'active',
          note: 'Investigate the possible rollback; it remains unverified.',
          sources: [{ sourceId: 's0', quote: 'Possible VM rollback; unverified.' }],
        },
        {
          section: 'next',
          note: 'Inspect current files before claiming a rollback.',
          sources: [{ sourceId: 's0', quote: 'Possible VM rollback; unverified.' }],
        },
      ]),
    ),
  );
  const text = await contextSummarizer(config, new AbortController().signal, () => {})(input, 1024);
  expect(JSON.parse(text)).toMatchObject({
    version: 2,
    entries: [
      { section: 'active', evidence: [{ origin: 'assistant_report' }] },
      { section: 'next', evidence: [{ origin: 'assistant_report' }] },
    ],
  });
  const request = generate.mock.calls[0][0];
  expect(request.tools).toBeUndefined();
  for (const rule of [
    'Organize by task state',
    'Preserve unresolved requests',
    'Newer explicit corrections',
    'not user approval',
    'last observed',
    'sources:[{sourceId,quote}]',
  ])
    expect(request.system).toContain(rule);
});
it('keeps handover instructions within the configured generation cap on large windows', async () => {
  generate.mockReset();
  generate.mockResolvedValue(
    result(
      JSON.stringify([
        {
          section: 'active',
          note: 'Unverified rollback report.',
          sources: [{ sourceId: 's0', quote: 'Possible VM rollback' }],
        },
      ]),
    ),
  );
  await contextSummarizer(
    { ...config, contextWindow: 256000, maxOutputTokens: 1024 },
    new AbortController().signal,
    () => {},
  )(input, 8192);
  expect(generate.mock.calls[0][0].system).toContain('under 819 tokens');
  expect(generate.mock.calls[0][0].maxOutputTokens).toBe(1024);
});
it('retries the old notes-only response instead of silently accepting it for a new handover', async () => {
  generate.mockReset();
  generate.mockResolvedValueOnce(
    result(
      JSON.stringify([
        { sourceId: 's0', note: 'Unverified rollback.', quote: 'Possible VM rollback' },
      ]),
    ),
  );
  generate.mockResolvedValueOnce(
    result(JSON.stringify([item('s0', 'Unverified rollback.', 'Possible VM rollback')])),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const text = await contextSummarizer(config, new AbortController().signal, () => {})(input, 1024);
  expect(JSON.parse(text).version).toBe(2);
  expect(generate).toHaveBeenCalledTimes(2);
});
it('retries invented citations and only returns grounded, origin-labelled memory', async () => {
  generate.mockReset();
  generate.mockResolvedValueOnce(
    result(JSON.stringify([item('invented', 'Rollback happened', 'verified')])),
  );
  generate.mockResolvedValueOnce(
    result(
      JSON.stringify([
        item('s0', 'Possible rollback; unverified assistant report', 'Possible VM rollback'),
      ]),
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const account = vi.fn();
  const text = await contextSummarizer(config, new AbortController().signal, account)(input, 1024);
  expect(JSON.parse(text).entries[0]).toMatchObject({
    section: 'context',
    evidence: [{ origin: 'assistant_report', quote: 'Possible VM rollback' }],
  });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(account).toHaveBeenCalledTimes(2);
});
it('recovers from ungrounded summaries after bounded retries and honors cancellation', async () => {
  generate.mockReset();
  generate.mockResolvedValue(
    result(JSON.stringify([item('s0', 'Rollback verified', 'Snapshot restore confirmed')])),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovery = vi.fn();
  const text = await contextSummarizer(
    config,
    new AbortController().signal,
    () => {},
    recovery,
  )(input, 1024);
  expect(JSON.parse(text).entries).toContainEqual({
    origin: 'assistant_report',
    note: expect.any(String),
    quote: 'Possible VM rollback; unverified.',
  });
  expect(text).not.toContain('Rollback verified');
  expect(recovery).toHaveBeenCalledWith({
    method: 'source_excerpts',
    reason: 'missing_evidence',
    attempts: 3,
    sourceCount: 1,
  });
  expect(warn.mock.calls[0][1]).toMatchObject({
    hasText: true,
    validMemory: false,
    reason: 'missing_evidence',
  });
  expect(generate).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('Snapshot restore');
  const controller = new AbortController();
  controller.abort();
  await expect(
    contextSummarizer(config, controller.signal, () => {})(input, 1024),
  ).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(3);
});

it('uses valid sibling entries without retrying unsupported claims', async () => {
  generate.mockReset();
  generate.mockResolvedValue(
    result(
      JSON.stringify([
        item('s0', 'Unverified assistant report.', 'Possible VM rollback'),
        item('missing', 'Invented.', 'Snapshot restored'),
      ]),
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovery = vi.fn();
  const text = await contextSummarizer(
    config,
    new AbortController().signal,
    () => {},
    recovery,
  )(input, 1024);
  expect(JSON.parse(text).entries).toEqual([
    {
      section: 'context',
      note: 'Unverified assistant report.',
      evidence: [{ origin: 'assistant_report', quote: 'Possible VM rollback' }],
    },
  ]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(recovery).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'verified_entries', reason: 'missing_source' }),
  );
});
it.each([
  '',
  '```json\nnot JSON\n```',
  JSON.stringify([item('s0', 'Too big '.repeat(100), 'Possible VM rollback')]),
])('falls back within a small budget for unusable output: %s', async (raw) => {
  generate.mockReset();
  generate.mockResolvedValue(result(raw));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovery = vi.fn();
  const text = await contextSummarizer(
    config,
    new AbortController().signal,
    () => {},
    recovery,
  )(input, 64);
  expect(JSON.parse(text).version).toBe(1);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 3);
  expect(recovery).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'source_excerpts', attempts: 3 }),
  );
});
it('recovers from summary provider errors without logging raw provider data', async () => {
  generate.mockReset();
  generate.mockRejectedValue(new Error('private-provider-key'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovery = vi.fn();
  const text = await contextSummarizer(
    config,
    new AbortController().signal,
    () => {},
    recovery,
  )(input, 1024);
  expect(text).toContain('Possible VM rollback; unverified.');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ reason: 'provider_error' }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-provider-key');
});
it('recovers without a provider request when only extractive compression fits', async () => {
  generate.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recovery = vi.fn();
  const text = await contextSummarizer(
    { ...config, contextWindow: 1024 },
    new AbortController().signal,
    () => {},
    recovery,
  )(input, 64);
  expect(JSON.parse(text).version).toBe(1);
  expect(generate).not.toHaveBeenCalled();
  expect(recovery).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'generation_headroom', attempts: 0 }),
  );
});
it.each(['success', 'failure'])(
  'does not recover over cancellation during a summary %s',
  async (outcome) => {
    generate.mockReset();
    const controller = new AbortController();
    generate.mockImplementationOnce(async () => {
      controller.abort(new Error('User stopped'));
      if (outcome === 'failure') throw new Error('Cancelled transport');
      return result('[]');
    });
    const recovery = vi.fn();
    await expect(
      contextSummarizer(config, controller.signal, () => {}, recovery)(input, 1024),
    ).rejects.toThrow('User stopped');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(recovery).not.toHaveBeenCalled();
  },
);
