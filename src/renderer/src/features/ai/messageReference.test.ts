import { expect, it } from 'vitest';
import { formatReference, splitReference } from './messageReference';

it('preserves saved references, blank lines, and quote markers when editing instructions', () => {
  const reference = {
    label: 'Scout: layout review',
    text: 'First line\n\n> Nested quote\nLast line',
  };
  const saved = formatReference('Focus on mobile.\nKeep the API stable.', reference);
  expect(splitReference(saved)).toEqual({
    reference,
    text: 'Focus on mobile.\nKeep the API stable.',
  });
  expect(
    splitReference(formatReference('Revised instruction.', splitReference(saved).reference)),
  ).toEqual({ reference, text: 'Revised instruction.' });
});

it('leaves ordinary messages and incomplete reference text intact', () => {
  for (const text of [
    'Use the mobile layout.',
    'Regarding the layout:\nKeep it compact.',
    'Regarding Scout:\n> Quote\nUnquoted text\n\nReply',
  ]) {
    expect(splitReference(text)).toEqual({ text });
  }
  expect(formatReference('Plain instruction.')).toBe('Plain instruction.');
});
