import { expect, it } from 'vitest';
import { CapabilityRedactor } from './redaction';

it('redacts original strings once, including escaped secrets, without masking inserted placeholders', () => {
  const redact = new CapabilityRedactor(new Set(['a', 'abcd', 'p"ass\nword', '']));
  expect(redact.text('[redacted]')).toEqual({ value: '[redacted]', count: 0 });
  expect(redact.text('abcd a')).toEqual({ value: '[redacted] [redacted]', count: 2 });
  const raw = JSON.stringify({ key: 'p"ass\nword' });
  expect(JSON.parse(redact.json(raw)!.value)).toEqual({ key: '[redacted]' });
});
it('rewrites typed JSON tokens without corrupting syntax, number precision, or untouched formatting', () => {
  const redact = new CapabilityRedactor(new Set(['993', 'false']));
  const raw =
    '{ "port":993, "nested":["993",false,12993], "id":900719925474099312345, "text":"host:993" }';
  const result = redact.json(raw)!;
  expect(result.count).toBe(4);
  expect(result.value).toContain('"id":900719925474099312345');
  expect(result.value).toContain('"port":"[redacted]"');
  expect(JSON.parse(result.value)).toMatchObject({
    port: '[redacted]',
    nested: ['[redacted]', '[redacted]', 12993],
    text: 'host:[redacted]',
  });
  expect(redact.json('{bad')).toBeUndefined();
  expect(redact.json('{ "port":443 }')).toEqual({ value: '{ "port":443 }', count: 0 });
});
it('preserves object structure while replacing matching numeric and boolean secret values with strings', () => {
  const redact = new CapabilityRedactor(new Set(['993', 'true']));
  expect(
    redact.value({ port: 993, other: 1993, enabled: true, missing: null, nested: [993] }),
  ).toEqual({
    value: {
      port: '[redacted]',
      other: 1993,
      enabled: '[redacted]',
      missing: null,
      nested: ['[redacted]'],
    },
    count: 3,
  });
});

it('protects JSON-valued credentials and JSON text nested in strings', () => {
  const redact = new CapabilityRedactor(new Set(['{"key":"private"}', '993']));
  expect(redact.value({ credentials: { key: 'private' } })).toEqual({
    value: { credentials: '[redacted]' },
    count: 1,
  });
  const raw = '{ "credentials": { "key": "private" }, "port":993 }';
  expect(JSON.parse(redact.json(raw)!.value)).toEqual({
    credentials: '[redacted]',
    port: '[redacted]',
  });
  const nested = redact.value({ payload: '{"port":993}' });
  expect(JSON.parse((nested.value as { payload: string }).payload)).toEqual({ port: '[redacted]' });
  expect(redact.json('{"key":"private"}')!.value).toBe('"[redacted]"');
});

it('bounds structural matching work for excessively nested JSON instead of stalling the backend', () => {
  const redact = new CapabilityRedactor(new Set(['{"key":"private"}']));
  const nested = '['.repeat(2500) + '0' + ']'.repeat(2500);
  expect(() => redact.json(nested)).toThrow('too complex to redact safely');
});
