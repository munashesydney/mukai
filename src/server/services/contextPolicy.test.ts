import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { ContextManager, contextLimits, contextUnits, estimateTokens } from './contextPolicy';
import { IMAGE_OMITTED } from './toolResultPolicy';

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
  it('preserves omitted-image notices when additional tools force results into compaction', async () => {
    const summarize = vi.fn(async () => 'Continue the current task; earlier operations completed.');
    const manager = new ContextManager(10000, 8192, 5000, summarize);
    const current: ModelMessage = { role: 'user', content: 'Continue the current task.' };
    const result = await manager.prepare([
      ...pair('old-image', IMAGE_OMITTED),
      ...pair('large', 'x'.repeat(12000)),
      current,
    ]);
    expect(summarize).toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain(IMAGE_OMITTED);
    expect(manager.summary).toContain(IMAGE_OMITTED);
    expect(manager.estimate(result)).toBeLessThanOrEqual(contextLimits(10000, 8192).hardInput);
    expect(result).toContainEqual(current);
  });
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
    expect(contextLimits(4096, 8192).output).toBe(512);
    expect(contextLimits(null, 8192).capacity).toBe(32768);
    expect(estimateTokens('🦊资料')).toBeGreaterThan(estimateTokens('abc'));
  });
  it.each([10000, 28000, 128000, 1000000])(
    'adapts output and result room to a %i-token context',
    async (capacity) => {
      const manager = new ContextManager(capacity, 8192, 4000, async () => 'Memory');
      const messages: ModelMessage[] = [{ role: 'user', content: 'Inspect the workspace.' }];
      const output = manager.outputAllowance(messages);
      expect(output).toBeLessThanOrEqual(8192);
      expect(manager.estimate(messages) + output).toBeLessThanOrEqual(capacity * 0.9);
      const allowance = manager.toolAllowance(messages);
      expect(allowance).toBeGreaterThan(256);
      expect(allowance).toBeLessThanOrEqual(capacity * 0.45);
      const bounded = manager.boundTools([
        ...messages,
        ...pair('huge', 'A useful finding.\n' + 'x'.repeat(capacity * 4)),
      ]);
      expect(estimateTokens(bounded.slice(1))).toBeLessThanOrEqual(allowance + 150);
    },
  );
  it('retains bounded recent operation evidence when tool definitions reduce context space', async () => {
    const summarize = vi.fn(
      async () => 'Browser verified. Resume with session demo; do not repeat completed actions.',
    );
    const manager = new ContextManager(10000, 8192, 4000, summarize);
    const user: ModelMessage = { role: 'user', content: 'Test the browser and report results.' };
    const messages = [user, ...pair('recent', 'verified '.repeat(3000))];
    const compacted = await manager.prepare(messages);
    expect(compacted).toContainEqual(user);
    expect(summarize).not.toHaveBeenCalled();
    expect(JSON.stringify(compacted)).toContain('verified');
    expect(JSON.stringify(compacted)).toContain('truncated');
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(messages).length);
    expect(messages).toEqual([user, ...pair('recent', 'verified '.repeat(3000))]);
    expect(manager.estimate(compacted) + manager.outputAllowance(compacted)).toBeLessThanOrEqual(
      9000,
    );
    expect(contextUnits(compacted)).toHaveLength(2);
  });
  it('shrinks output for a large mandatory request without truncating it or inventing compaction', async () => {
    const summarize = vi.fn(async () => 'Memory');
    const manager = new ContextManager(10000, 8192, 4000, summarize);
    const messages: ModelMessage[] = [{ role: 'user', content: 'x'.repeat(13000) }];
    expect(await manager.prepare(messages)).toBe(messages);
    expect(manager.outputAllowance(messages)).toBeLessThan(1250);
    expect(
      manager.estimate(messages) + manager.outputAllowance(messages, 50) + 50,
    ).toBeLessThanOrEqual(9000);
    expect(manager.compactions).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });
  it('estimates PNG screenshots by dimensions and excludes old pixels from summary requests', async () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(1024, 16);
    header.writeUInt32BE(768, 20);
    const pixels = header.toString('base64') + 'base64-secret-pixels'.repeat(100000);
    const image = { type: 'file' as const, mediaType: 'image/png', data: pixels };
    expect(estimateTokens(image)).toBe(1536);
    expect(estimateTokens({ ...image, data: 'unknown format' })).toBe(8192);
    const summarize = vi.fn(async (data: string) => {
      expect(data).toContain('<historical-data>');
      return 'Page observations preserved; retake the screenshot if needed.';
    });
    const manager = new ContextManager(10000, 8192, 4000, summarize);
    await manager.prepare(
      [
        { role: 'user', content: [image] },
        { role: 'assistant', content: 'Page verified' },
        { role: 'user', content: 'Continue' },
      ],
      true,
    );
    expect(summarize.mock.calls[0][0]).not.toContain('base64-secret-pixels');
    expect(summarize.mock.calls[0][0]).toContain('do not invent visual findings');
  });
});
