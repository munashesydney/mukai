import { afterEach, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import type { ProviderService } from './providerService';
import { contextSummarizer } from './contextSummary';
vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: vi.fn(),
}));
const generate = vi.mocked(generateText);
const config = {
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
it('retries invented citations and only returns grounded, origin-labelled memory', async () => {
  generate.mockReset();
  generate.mockResolvedValueOnce(
    result('[{"sourceId":"invented","note":"Rollback happened","quote":"verified"}]'),
  );
  generate.mockResolvedValueOnce(
    result(
      '[{"sourceId":"s0","note":"Possible rollback; unverified assistant report","quote":"Possible VM rollback"}]',
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const account = vi.fn();
  const text = await contextSummarizer(config, new AbortController().signal, account)(input, 1024);
  expect(JSON.parse(text).entries[0]).toMatchObject({
    origin: 'assistant_report',
    quote: 'Possible VM rollback',
  });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(account).toHaveBeenCalledTimes(2);
});
it('rejects an ungrounded notebook after bounded retries and honors cancellation', async () => {
  generate.mockReset();
  generate.mockResolvedValue(
    result('[{"sourceId":"s0","note":"Rollback verified","quote":"Snapshot restore confirmed"}]'),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(
    contextSummarizer(config, new AbortController().signal, () => {})(input, 1024),
  ).rejects.toThrow('ungrounded source references');
  expect(generate).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('Snapshot restore');
  const controller = new AbortController();
  controller.abort();
  await expect(
    contextSummarizer(config, controller.signal, () => {})(input, 1024),
  ).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(3);
});
