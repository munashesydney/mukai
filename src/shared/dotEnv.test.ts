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
