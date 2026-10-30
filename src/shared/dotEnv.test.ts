import { describe, expect, it } from 'vitest';
import { parseDotEnv } from './dotEnv';
describe('Environment import', () => {
  it('previews comments, exports, quotes, multiline values, and duplicate replacement', () => {
    expect(
      parseDotEnv(
        '# note\nexport TOKEN="a#b"\nEMPTY=\nMULTI=\'first\nsecond\'\nTOKEN=latest # comment',
      ),
    ).toEqual([
      { name: 'TOKEN', value: 'latest' },
      { name: 'EMPTY', value: '' },
      { name: 'MULTI', value: 'first\nsecond' },
    ]);
  });
  it('rejects incomplete or invalid entries without saving anything', () => {
    expect(() => parseDotEnv('VALID=one\nnot an entry')).toThrow('line 2');
    expect(() => parseDotEnv('KEY="unfinished')).toThrow('quoted value');
  });
});
it('round-trips exported values without losing quotes, literal escapes, newlines or empty strings', async () => {
  const { serializeDotEnv } = await import('./dotEnv');
  const values = [
    '',
    ' leading and trailing ',
    'both\' and " plus ` quotes # $',
    'literal \\n \\r and C:\\temp\\new',
    'first\nsecond\r\nthird\ttab',
    '\0\b\f',
    '资料🦊',
  ];
  const entries = values.map((value, index) => ({ name: 'EXPORT_' + index, value }));
  expect(parseDotEnv(serializeDotEnv(entries))).toEqual(entries);
  expect(parseDotEnv(serializeDotEnv(entries).replace(/\n/g, '\r\n'))).toEqual(entries);
  expect(() => serializeDotEnv([{ name: 'INVALID-NAME', value: 'test' }])).toThrow('name');
});
