import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { estimateTokens } from './contextPolicy';
import {
  IMAGE_OMITTED,
  RESULT_TRUNCATED,
  limitResultText,
  limitToolGroups,
  limitToolOutput,
  resultPreview,
} from './toolResultPolicy';

describe('bounded tool results', () => {
  it('reports actual image delivery after pixel and shared binary limits', () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(30, 16);
    header.writeUInt32BE(20, 20);
    const content = {
      type: 'content' as const,
      value: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            result: { path: '/saved.png', imageIncluded: true, imageDelivery: 'included' },
          }),
        },
        {
          type: 'file' as const,
          mediaType: 'image/png',
          data: {
            type: 'data' as const,
            data: Buffer.concat([header, Buffer.alloc(1024 * 1024)]).toString('base64'),
          },
        },
      ],
    };
    const metadata = (output: typeof content) =>
      JSON.parse((output.value[0] as { text: string }).text).result;
    expect(
      metadata(limitToolOutput(content, 6000, estimateTokens) as typeof content),
    ).toMatchObject({ imageIncluded: true, imageDelivery: 'included' });
    const omitted = limitToolOutput(content, 400, estimateTokens);
    expect(JSON.stringify(omitted)).toContain(IMAGE_OMITTED);
    expect(metadata(omitted as typeof content)).toMatchObject({
      imageIncluded: false,
      imageDelivery: 'omitted',
    });
    const messages: ModelMessage[] = ['old', 'new'].map((toolCallId) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'browser', output: content }],
    }));
    const bounded = limitToolGroups(messages, 6000, estimateTokens);
    const old = bounded[0];
    if (old.role !== 'tool' || old.content[0].type !== 'tool-result')
      throw new Error('Missing tool output');
    expect(metadata(old.content[0].output as typeof content)).toMatchObject({
      imageIncluded: false,
      imageDelivery: 'omitted',
    });
  });
  it('preserves omitted-image notices when an added default tool leaves very little result room', () => {
    const output = {
      type: 'content' as const,
      value: [
        { type: 'text' as const, text: 'Screenshot recorded at /browser/fixture/screenshot.' },
        {
          type: 'file' as const,
          mediaType: 'image/png',
          data: { type: 'data' as const, data: 'unseen-image' },
        },
      ],
    };
    const limited = limitToolOutput(output, 128, estimateTokens);
    expect(JSON.stringify(limited)).toContain(IMAGE_OMITTED);
    expect(JSON.stringify(limited)).not.toContain('unseen-image');
    expect(estimateTokens(limited)).toBeLessThanOrEqual(128);
    const repeated = limitToolOutput(output, 256, estimateTokens);
    expect(JSON.stringify(limitToolOutput(repeated, 128, estimateTokens))).toContain(IMAGE_OMITTED);
    expect(limitResultText('Long prefix '.repeat(100) + IMAGE_OMITTED, 256)).toContain(
      IMAGE_OMITTED,
    );
  });
  it('preserves ordinary structured results and UTF-8 text', () => {
    const result = { ok: true, files: ['notes.md', '资料🦊'], count: 2 };
    expect(JSON.parse(resultPreview(result, 4096))).toEqual(result);
    expect(limitResultText('资料🦊', 100)).toBe('资料🦊');
    expect(limitToolOutput({ type: 'text', value: 'normal result' }, 1000, estimateTokens)).toEqual(
      { type: 'text', value: 'normal result' },
    );
  });
  it('keeps a useful prefix and explicit ending without splitting Unicode', () => {
    const original = 'Useful findings:\n' + '资料🦊'.repeat(100000);
    const limited = limitToolOutput({ type: 'text', value: original }, 1000, estimateTokens);
    expect(limited.type).toBe('text');
    if (limited.type !== 'text') throw new Error('Expected text');
    expect(limited.value).toMatch(/^Useful findings:/);
    expect(limited.value.endsWith(RESULT_TRUNCATED)).toBe(true);
    expect(limited.value).not.toContain('\ufffd');
    expect(estimateTokens(limited)).toBeLessThanOrEqual(1000);
    expect(original.length).toBeGreaterThan(100000);
  });
  it('bounds huge, deeply nested, circular, and unreadable results before serialization', () => {
    const cycle: Record<string, unknown> = {
      first: 'keep this',
      rows: Array(100000).fill('entry'),
    };
    cycle.self = cycle;
    for (const result of [
      cycle,
      { huge: 'x'.repeat(2000000) },
      {
        get field() {
          throw new Error('getter');
        },
      },
      (() => {
        let value: unknown = 'end';
        for (let i = 0; i < 1000; i++) value = { value };
        return value;
      })(),
    ]) {
      const preview = resultPreview(result, 3000);
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(3000);
      expect(preview.endsWith(RESULT_TRUNCATED)).toBe(true);
    }
    const smallCycle: Record<string, unknown> = { first: 'keep this' };
    smallCycle.self = smallCycle;
    expect(resultPreview(smallCycle, 3000)).toContain('Circular'.toLowerCase());
  });
  it('shares an allowance across parallel results without changing IDs or atomic structure', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: ['a', 'b', 'c'].map((toolCallId) => ({
          type: 'tool-call' as const,
          toolCallId,
          toolName: 'browser',
          input: {},
        })),
      },
      ...['a', 'b', 'c'].map((toolCallId) => ({
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId,
            toolName: 'browser',
            output: { type: 'text' as const, value: 'first finding\n' + 'x'.repeat(100000) },
          },
        ],
      })),
    ];
    const bounded = limitToolGroups(messages, 3000, estimateTokens);
    expect(bounded[0]).toEqual(messages[0]);
    expect(estimateTokens(bounded.slice(1))).toBeLessThanOrEqual(3000);
    for (let i = 1; i < bounded.length; i++) {
      const result = bounded[i];
      if (result.role !== 'tool') throw new Error('Expected tool');
      expect(result.content[0]).toMatchObject({ toolCallId: ['a', 'b', 'c'][i - 1] });
      expect(JSON.stringify(result)).toContain(RESULT_TRUNCATED);
    }
    expect(JSON.stringify(messages)).not.toContain(RESULT_TRUNCATED);
  });
  it('retains images when they fit and explicitly reports omitted pixels or trailing blocks', () => {
    const image = {
      type: 'file' as const,
      mediaType: 'image/png',
      data: { type: 'data' as const, data: 'unknown-image' },
    };
    const output = {
      type: 'content' as const,
      value: [{ type: 'text' as const, text: 'Screenshot /browser/id/screenshot' }, image],
    };
    expect(limitToolOutput(output, 10000, estimateTokens)).toEqual(output);
    const omitted = limitToolOutput(output, 1000, estimateTokens);
    expect(JSON.stringify(omitted)).toContain(IMAGE_OMITTED);
    expect(JSON.stringify(omitted)).toContain('/browser/id/screenshot');
    expect(JSON.stringify(omitted)).not.toContain('unknown-image');
    const trailing = limitToolOutput(
      {
        type: 'content',
        value: [
          { type: 'text', text: 'x'.repeat(100000) },
          image,
          { type: 'text', text: 'last block' },
        ],
      },
      1000,
      estimateTokens,
    );
    expect(JSON.stringify(trailing)).toContain(RESULT_TRUNCATED);
    expect(estimateTokens(trailing)).toBeLessThanOrEqual(1000);
  });
  it('bounds binary transport even when image dimensions hide huge payloads', () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(512, 16);
    header.writeUInt32BE(512, 20);
    const image = (bytes: number) => ({
      type: 'file' as const,
      mediaType: 'image/png',
      data: {
        type: 'data' as const,
        data: Buffer.concat([header, Buffer.alloc(bytes)]).toString('base64'),
      },
    });
    const huge = limitToolOutput(
      { type: 'content', value: [image(3 * 1024 * 1024)] },
      6000,
      estimateTokens,
    );
    expect(JSON.stringify(huge)).toContain(IMAGE_OMITTED);
    const messages: ModelMessage[] = ['old', 'new'].flatMap((toolCallId) => [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool-call' as const, toolCallId, toolName: 'browser', input: {} }],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId,
            toolName: 'browser',
            output: { type: 'content' as const, value: [image(1024 * 1024)] },
          },
        ],
      },
    ]);
    const bounded = limitToolGroups(messages, 6000, estimateTokens);
    expect(JSON.stringify(bounded[1])).toContain(IMAGE_OMITTED);
    expect(JSON.stringify(bounded[3])).not.toContain(IMAGE_OMITTED);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(2 * 1024 * 1024);
  });
});
