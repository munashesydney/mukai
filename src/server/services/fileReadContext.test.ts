import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { fileReadContext } from './fileReadContext';
import { ContextManager, estimateTokens } from './contextPolicy';
import { limitToolGroups, RESULT_TRUNCATED } from './toolResultPolicy';

const text = 'Actual file contents, including exact identifiers.\n'.repeat(150);
function read(id: string, overrides: Record<string, unknown> = {}): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: 'file_operations',
          input: { action: 'read_file', path: 'notes.txt' },
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
          output: {
            type: 'text',
            value: JSON.stringify({
              ok: true,
              action: 'read_file',
              path: 'notes.txt',
              summary: 'Read lines 1–151 of 300.',
              startLine: 1,
              endLine: 151,
              totalLines: 300,
              truncated: true,
              content: text,
              warnings: [],
              ...overrides,
            }),
          },
        },
      ],
    },
  ];
}
function output(messages: ModelMessage[], id: string) {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolCallId === id && part.output.type === 'text')
        return JSON.parse(part.output.value);
    }
  }
  throw new Error('Missing result: ' + id);
}

describe('retained file read context', () => {
  it('sends one full copy and small references, preserving raw results and stable prefixes', () => {
    const first = read('first');
    const history = [...first, ...read('second'), ...read('third')];
    const saved = JSON.stringify(history);
    const projected = fileReadContext(history);
    expect(output(projected, 'first').content).toBe(text);
    expect(output(projected, 'second')).toMatchObject({
      unchanged: true,
      sourceToolCallId: 'first',
      truncated: true,
      startLine: 1,
      endLine: 151,
      warnings: [],
    });
    expect(output(projected, 'second').content).toBeUndefined();
    expect(output(projected, 'third').sourceToolCallId).toBe('first');
    expect(projected.slice(0, first.length)).toEqual(fileReadContext(first));
    expect(JSON.stringify(history)).toBe(saved);
    expect(fileReadContext(projected)).toEqual(projected);
    expect(estimateTokens(projected)).toBeLessThan(estimateTokens(history) / 2);
  });

  it.each([
    { path: 'other.txt' },
    { startLine: 2 },
    { endLine: 152 },
    { totalLines: 301 },
    { content: text + 'changed' },
    { ok: false },
    { content: '' },
  ])('keeps a full result when the file, range, contents or outcome differ: %j', (change) => {
    const history = [...read('first'), ...read('second', change)];
    expect(fileReadContext(history)).toBe(history);
  });

  it('sends full contents again when the source is removed, including after checkpoint reload', () => {
    const history = JSON.parse(
      JSON.stringify([...read('first'), ...read('second'), ...read('third')]),
    );
    const retained = history.slice(2);
    const projected = fileReadContext(retained);
    expect(output(projected, 'second').content).toBe(text);
    expect(output(projected, 'third').sourceToolCallId).toBe('second');
  });

  it('does not reference a source whose output was shortened by the tool limiter', () => {
    const clipped = limitToolGroups(read('first'), 256, estimateTokens);
    expect(JSON.stringify(clipped)).toContain(RESULT_TRUNCATED);
    const projected = fileReadContext([...clipped, ...read('second')]);
    expect(output(projected, 'second').content).toBe(text);
  });

  it('leaves tiny reads, malformed output and execute_code results untouched', () => {
    const tiny = [...read('first', { content: 'short' }), ...read('second', { content: 'short' })];
    expect(fileReadContext(tiny)).toBe(tiny);
    const other = read('code');
    const result = other[1];
    if (result.role !== 'tool' || result.content[0].type !== 'tool-result') throw new Error();
    result.content[0].toolName = 'execute_code';
    const malformed = read('bad');
    const bad = malformed[1];
    if (bad.role !== 'tool' || bad.content[0].type !== 'tool-result') throw new Error();
    bad.content[0].output = { type: 'text', value: '{not JSON' };
    const history = [...read('first'), ...other, ...malformed];
    expect(fileReadContext(history)).toBe(history);
  });

  it('budgets the wire view and restores full evidence when compaction drops the source', async () => {
    const summarize = vi.fn(async () => 'Earlier work saved; inspect original history as needed.');
    const manager = new ContextManager(32768, 2048, 100, summarize);
    const task: ModelMessage = { role: 'user', content: 'Continue this exact request.' };
    const history = [...read('first'), task, ...read('second'), ...read('third')];
    expect(manager.estimate(history)).toBe(100 + estimateTokens(fileReadContext(history)));
    manager.calibrate(history, manager.estimate(history));
    expect(manager.factor).toBe(1);
    const compacted = await manager.prepare(history, true);
    const projected = manager.modelMessages(compacted);
    expect(output(projected, 'second').content).toBe(text);
    expect(output(projected, 'third').sourceToolCallId).toBe('second');
    expect(
      projected.some((message) => JSON.stringify(message).includes('"toolCallId":"first"')),
    ).toBe(false);
    expect(manager.estimate(compacted)).toBeLessThan(32768 * 0.9);
  });
});
