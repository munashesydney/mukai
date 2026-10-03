import { describe, expect, it } from 'vitest';
import { patchText } from './patchText';

describe('patch matching', () => {
  it('preserves BOM and CRLF when the model supplies LF', () => {
    expect(patchText('\uFEFFa\r\nb\r\nc', 'a\nb', 'x\ny')).toBe('\uFEFFx\r\ny\r\nc');
  });
  it('allows trailing whitespace differences without changing unrelated bytes', () => {
    expect(patchText('before\n  a  \n  b\nafter', '  a\n  b', '  c')).toBe('before\n  c\nafter');
  });
  it('prefers an exact match over normalized candidates', () => {
    expect(patchText('a\nb\na  \nb', 'a\nb', 'c')).toBe('c\na  \nb');
  });
  it('rejects ambiguous normalized and overlapping matches', () => {
    expect(() => patchText('a \nb\na\r\nb', 'a\nb', 'c')).toThrow('2 matches');
    expect(() => patchText('aaa', 'aa', 'b')).toThrow('2 matches');
  });
  it('does not guess indentation or substantive code changes', () => {
    expect(() => patchText('  a\n  b', 'a\nb', 'c')).toThrow('No matching text');
    expect(() => patchText('hello', 'world', 'c')).toThrow('No edits were made');
  });
});
