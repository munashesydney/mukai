import { expect, it } from 'vitest';
import { ProcessRedactor } from './processRedactor';

it('handles saved values containing unpaired UTF-16 surrogates', () => {
  const redactor = new ProcessRedactor(['key-\ud800']);
  expect(redactor.write('key-\ud800', true)).toBe('[redacted]');
});

it('withholds secret prefixes and redacts secrets across arbitrary stream boundaries', () => {
  const redactor = new ProcessRedactor(['private-token-123']);
  expect(redactor.write('ready: pri')).toBe('ready: ');
  expect(redactor.write('vate-token-')).toBe('');
  expect(redactor.write('123\nfinished')).toBe('[redacted]\nfinished');
  expect(redactor.finish()).toBe('');
});
it('redacts encoded representations and overlapping secrets without corrupting ordinary output', () => {
  const secrets = ['ab', 'abcdef', 'key with / symbols'];
  const redactor = new ProcessRedactor(secrets);
  const text = [
    'abcdef',
    encodeURIComponent(secrets[2]),
    Buffer.from(secrets[2]).toString('base64'),
  ].join('\n');
  let output = '';
  for (const character of text) output += redactor.write(character);
  output += redactor.finish();
  expect(output).toBe('[redacted]\n[redacted]\n[redacted]');
  const plain = new ProcessRedactor(['private-token']);
  expect(plain.write('a price: pri')).toBe('a price: ');
  expect(plain.finish()).toBe('pri');
});
