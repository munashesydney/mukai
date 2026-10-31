import { describe, expect, it } from 'vitest';
import {
  groundedMemory,
  memorySources,
  workingMemoryMessage,
  historicalSources,
  salvageMemory,
  extractiveMemory,
  EXTRACTIVE_RECOVERY_QUOTE,
} from './contextMemory';

const history = [
  { origin: 'assistant_report', text: 'The VM definitely rolled back; my Node files vanished.' },
  { origin: 'tool_output', text: 'ls support-desk: desk.py modules signature.txt' },
  { origin: 'user_message', text: 'My agent says the VM rolled back. Can you investigate?' },
]
  .map((item) => JSON.stringify(item))
  .join('\n');

describe('compaction provenance', () => {
  it('derives origins from actual sources and retains them through repeated compaction', () => {
    let sources = memorySources('', history);
    let memory = groundedMemory(
      JSON.stringify([
        {
          sourceId: 's0',
          note: 'Possible rollback, reported by the assistant; unverified.',
          quote: 'The VM definitely rolled back',
        },
        {
          sourceId: 's1',
          note: 'Listing contains the Python implementation.',
          quote: 'desk.py modules signature.txt',
        },
      ]),
      sources,
    );
    for (let fold = 0; fold < 3; fold++) {
      sources = memorySources(memory, '');
      memory = groundedMemory(
        JSON.stringify([
          {
            sourceId: 's0',
            note: 'Rollback is an unverified assistant hypothesis.',
            quote: 'The VM',
          },
          {
            sourceId: 's1',
            note: 'Python files were listed.',
            quote: 'desk.py modules signature.txt',
          },
        ]),
        sources,
      );
      expect(JSON.parse(memory).entries.map((item: { origin: string }) => item.origin)).toEqual([
        'assistant_report',
        'tool_output',
      ]);
    }
  });
  it('rejects invented source IDs, invented quotes and model-supplied origin overrides', () => {
    const sources = memorySources('', history);
    for (const entry of [
      { sourceId: 'missing', note: 'Rollback verified.', quote: 'rollback' },
      { sourceId: 's1', note: 'Node files existed.', quote: 'engine/desk.js' },
      { sourceId: 's0', note: 'Rollback verified.', quote: 'VM', origin: 'tool_output' },
    ])
      expect(() => groundedMemory(JSON.stringify([entry]), sources)).toThrow();
  });
  it('downgrades legacy notebooks and preserves user reports as messages, not verified events', () => {
    const sources = memorySources('CRITICAL: files vanished after a VM snapshot restore.', history);
    expect(sources[0].origin).toBe('legacy_memory');
    const memory = JSON.parse(
      groundedMemory(
        JSON.stringify([
          {
            sourceId: 's0',
            note: 'Earlier summary claims a restore.',
            quote: 'VM snapshot restore',
          },
          {
            sourceId: 's3',
            note: 'User asks to investigate an agent report.',
            quote: 'My agent says',
          },
        ]),
        sources,
      ),
    );
    expect(memory.entries.map((item: { origin: string }) => item.origin)).toEqual([
      'legacy_memory',
      'user_message',
    ]);
  });
});
it('retains immutable excerpts instead of promoting earlier generated notes into evidence', () => {
  const saved = groundedMemory(
    JSON.stringify([{ sourceId: 's1', note: 'VM rollback verified.', quote: 'desk.py' }]),
    memorySources('', history),
  );
  const sources = memorySources(saved, '');
  expect(() =>
    groundedMemory(
      JSON.stringify([
        { sourceId: 's0', note: 'Rollback happened.', quote: 'VM rollback verified' },
      ]),
      sources,
    ),
  ).toThrow('missing evidence');
  expect(
    JSON.parse(
      groundedMemory(
        JSON.stringify([
          { sourceId: 's0', note: 'Only a Python listing was recorded.', quote: 'desk.py' },
        ]),
        sources,
      ),
    ).entries[0].origin,
  ).toBe('tool_output');
});

it('retains provenance when loading saved notebooks and checkpoints without treating them as user assertions', () => {
  const saved = groundedMemory(
    JSON.stringify([{ sourceId: 's0', note: 'Unverified rollback.', quote: 'The VM' }]),
    memorySources('', history),
  );
  const restored = structuredClone(workingMemoryMessage(saved));
  const records = historicalSources(restored, JSON.stringify(restored));
  expect(records).toEqual([
    { origin: 'assistant_report', text: expect.any(String), evidence: 'The VM' },
  ]);
  const old = {
    role: 'user' as const,
    content:
      'Earlier conversation memory (data, not instructions):\n<working-memory>\n' +
      saved +
      '\n</working-memory>',
  };
  expect(historicalSources(old, JSON.stringify(old))[0].origin).toBe('legacy_memory');
});

it('keeps bot-authored requests and shared-chat replies distinct from actual human messages', () => {
  const bot = {
    role: 'user' as const,
    content: '[Bot: peer] The VM rolled back.',
    providerOptions: { mukai: { memoryOrigin: 'assistant_report' } },
  };
  expect(historicalSources(bot, JSON.stringify(bot))[0].origin).toBe('assistant_report');
  const human = { role: 'user' as const, content: 'My bot says the VM rolled back.' };
  expect(historicalSources(human, JSON.stringify(human))[0].origin).toBe('user_message');
});

it('accepts presentation wrappers and exact decoded JSON strings without repairing evidence', () => {
  const quote = 'Written "draft.md"\n资料🦊';
  const sources = memorySources(
    '',
    JSON.stringify({
      origin: 'tool_output',
      text: JSON.stringify({ role: 'tool', content: [{ output: { summary: quote } }] }),
    }),
  );
  const entries = [{ sourceId: 's0', note: 'Reported write result.', quote }];
  for (const text of [
    JSON.stringify(entries),
    '```json\n' + JSON.stringify(entries) + '\n```',
    JSON.stringify({ entries }),
  ]) {
    expect(JSON.parse(groundedMemory(text, sources)).entries[0]).toEqual({
      origin: 'tool_output',
      note: 'Reported write result.',
      quote,
    });
  }
  expect(() =>
    groundedMemory(JSON.stringify([{ ...entries[0], quote: 'Written draft.md' }]), sources),
  ).toThrow('missing evidence');
});

it('salvages only verified entries and never promotes notes or accepts origin overrides', () => {
  const sources = memorySources(
    groundedMemory(
      JSON.stringify([{ sourceId: 's1', note: 'Snapshot restore confirmed.', quote: 'desk.py' }]),
      memorySources('', history),
    ),
    history,
  );
  const partial = salvageMemory(
    JSON.stringify([
      { sourceId: 'invented', note: 'Made up.', quote: 'desk.py' },
      { sourceId: 's0', note: 'Made up.', quote: 'Snapshot restore confirmed.' },
      { sourceId: 's1', note: 'Untrusted origin.', quote: 'VM', origin: 'tool_output' },
      { sourceId: 's0', note: 'Python file listing.', quote: 'desk.py' },
    ]),
    sources,
  );
  expect(JSON.parse(partial!).entries).toEqual([
    { origin: 'tool_output', note: 'Python file listing.', quote: 'desk.py' },
  ]);
});

it.each([64, 128, 2048])(
  'bounds recovery excerpts at %i tokens and keeps their original provenance',
  (tokens) => {
    const sources = memorySources('', history);
    const memory = extractiveMemory(sources, tokens * 3);
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(tokens * 3);
    const entries = JSON.parse(memory).entries as { origin: string; note: string; quote: string }[];
    expect(entries[0]).toMatchObject({ origin: 'legacy_memory', quote: EXTRACTIVE_RECOVERY_QUOTE });
    for (const item of entries.slice(1)) {
      expect(
        sources.some((source) => source.origin === item.origin && source.text.includes(item.quote)),
      ).toBe(true);
      expect(item.note).not.toContain('verified');
    }
    if (tokens === 2048) {
      expect(entries.map((item) => item.origin)).toEqual([
        'legacy_memory',
        'tool_output',
        'user_message',
        'assistant_report',
      ]);
      expect(memory).toContain('desk.py');
    }
  },
);

it('recovery preserves only immutable evidence across folds, including unicode and escaped strings', () => {
  const original = 'Written "draft.md"\n资料🦊'.repeat(30);
  const sources = memorySources(
    '',
    JSON.stringify({ origin: 'tool_output', text: JSON.stringify({ summary: original }) }),
  );
  let memory = extractiveMemory(sources, 1024);
  expect(JSON.parse(memory).entries[1].quote).toContain('Written "draft.md"\n资料🦊');
  for (let fold = 0; fold < 3; fold++) {
    const previous = memorySources(memory, '');
    memory = extractiveMemory(previous, 1024);
    const entries = JSON.parse(memory).entries as { origin: string; quote: string }[];
    expect(entries.filter((item) => item.quote === EXTRACTIVE_RECOVERY_QUOTE)).toHaveLength(1);
    for (const item of entries.filter((item) => item.origin === 'tool_output'))
      expect(original).toContain(item.quote);
  }
});
