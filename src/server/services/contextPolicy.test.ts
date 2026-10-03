import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { ContextManager, contextLimits, contextUnits, estimateTokens } from './contextPolicy';

const pair = (id: string, text = 'result'): ModelMessage[] => [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'file_operations',
        input: { action: 'read_file', path: id },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'file_operations',
        output: { type: 'text', value: text },
      },
    ],
  },
];
const history = (): ModelMessage[] => [
  { role: 'user', content: 'old findings '.repeat(4000) },
  ...pair('old', 'Verified existing file.'),
  { role: 'user', content: 'Exact current request: modify draft.md, preserve original.' },
  ...pair('first'),
  ...pair('second'),
  ...pair('third'),
];
describe('working context', () => {
  it('keeps the exact current request and recent complete operation pairs', async () => {
    const summarize = vi.fn(
      async () => 'Goal: modify draft.md. Earlier file verified. First operation completed.',
    );
    const manager = new ContextManager(16384, 2048, 100, summarize);
    const original = history();
    const snapshot = structuredClone(original);
    const compacted = await manager.prepare(original);
    expect(summarize).toHaveBeenCalled();
    expect(compacted).toContainEqual(original[3]);
    expect(compacted.slice(-4)).toEqual([...pair('second'), ...pair('third')]);
    expect(contextUnits(compacted)).toHaveLength(4);
    expect(JSON.stringify(compacted)).not.toContain('old findings old findings');
    expect(original).toEqual(snapshot);
    expect(manager.compactions).toBe(1);
    expect(manager.summary).toContain('Earlier file verified');
  });
  it('commits no summary when any chunk fails and leaves original messages intact', async () => {
    const summarize = vi
      .fn()
      .mockResolvedValueOnce('Candidate memory.')
      .mockRejectedValue(new Error('offline'));
    const manager = new ContextManager(16384, 2048, 100, summarize);
    manager.summary = 'Previous usable memory.';
    const original = history();
    await expect(manager.prepare(original)).rejects.toThrow('offline');
    expect(manager.summary).toBe('Previous usable memory.');
    expect(manager.compactions).toBe(0);
    expect(original[0].content).toContain('old findings');
  });
  it('refuses to truncate oversized latest text, documents, or images', async () => {
    const summarize = vi.fn(async () => 'Memory');
    const manager = new ContextManager(8192, 2048, 100, summarize);
    await expect(manager.prepare([{ role: 'user', content: 'x'.repeat(30000) }])).rejects.toThrow(
      'current request',
    );
    await expect(
      manager.prepare([
        { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'tiny-image' }] },
      ]),
    ).rejects.toThrow('current request');
    expect(summarize).not.toHaveBeenCalled();
  });
  it('does not compact small histories, but supports a forced overflow recovery', async () => {
    const summarize = vi.fn(async () => 'Earlier context');
    const manager = new ContextManager(16384, 1024, 100, summarize);
    const original: ModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'now' },
    ];
    expect(await manager.prepare(original)).toBe(original);
    expect(summarize).not.toHaveBeenCalled();
    expect(await manager.prepare(original, true)).toContainEqual(original[2]);
    expect(manager.compactions).toBe(1);
  });
  it('bounds summary requests, including previous summary and non-Latin content', async () => {
    const requests: string[] = [];
    const manager = new ContextManager(16384, 2048, 100, async (data) => {
      requests.push(data);
      return 'Verified data '.repeat(50);
    });
    await manager.prepare([
      { role: 'user', content: '资料🦊'.repeat(6000) },
      { role: 'assistant', content: 'old' },
      { role: 'user', content: 'next' },
    ]);
    expect(requests.length).toBeGreaterThan(1);
    for (const data of requests) expect(estimateTokens(data) + 600 + 2048).toBeLessThan(16384);
  });
  it('rejects empty and oversized summaries without committing them', async () => {
    for (const text of ['', 'x'.repeat(15000)]) {
      const manager = new ContextManager(16384, 2048, 100, async () => text);
      await expect(manager.prepare(history())).rejects.toThrow('unusable summary');
      expect(manager.compactions).toBe(0);
    }
  });
  it('calibrates estimates upward when a provider reports more input tokens', async () => {
    const manager = new ContextManager(16384, 2048, 100, async () => 'memory');
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const before = manager.estimate(messages);
    manager.calibrate(messages, before * 2);
    expect(manager.estimate(messages)).toBe(before * 2);
    manager.calibrate(messages, 1);
    expect(manager.estimate(messages)).toBe(before * 2);
  });
  it('preserves all parallel call/results and refuses orphan results', () => {
    const call: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'browser', input: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'browser', input: {} },
      ],
    };
    const results = [pair('a')[1], pair('b')[1]];
    expect(contextUnits([call, ...results])).toEqual([[call, ...results]]);
    expect(() => contextUnits(results)).toThrow('missing their original calls');
  });
  it('reserves output space and treats unknown capacity conservatively', () => {
    expect(contextLimits(4096, 8192).output).toBe(1024);
    expect(contextLimits(null, 8192).capacity).toBe(32768);
    expect(estimateTokens('🦊资料')).toBeGreaterThan(estimateTokens('abc'));
  });
});
