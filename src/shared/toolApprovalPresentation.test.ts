import { expect, it } from 'vitest';
import { toolApprovalPresentation } from './toolApprovalPresentation';

it('shows every parameter readably by default, including nested and empty values', () => {
  const result = toolApprovalPresentation({
    recipientEmail: 'jane@example.com',
    send_now: false,
    amount: 0,
    options: { copy_to: ['A', 'B'], note: null },
    attachments: [],
    metadata: {},
    empty: '',
  });
  expect(result).toContain('**Recipient Email:** jane@example.com');
  expect(result).toContain('**Send now:** false');
  expect(result).toContain('**Amount:** 0');
  expect(result).toContain('- **Copy to:**\n\n  - A\n  - B');
  expect(result).toContain('**Note:** None');
  expect(result).toContain('(empty list)');
  expect(result).toContain('(empty object)');
  expect(result).toContain('**Empty:** (empty)');
  expect(toolApprovalPresentation({})).toBe('No parameters.');
});

it('uses configured field order and labels with actual arguments, and preserves Markdown', () => {
  const result = toolApprovalPresentation(
    { to: 'Jane', body: '# Invoice\n\n**Total:** $250', internal: 42 },
    {
      title: 'Send this **email**?',
      fields: [
        { parameter: 'body', label: 'Message', presentation: 'long_text' },
        { parameter: 'to', label: 'Recipient' },
        { parameter: 'missing' },
      ],
    },
  );
  expect(result).toBe(
    'Send this **email**?\n\n**Message:**\n\n# Invoice\n\n**Total:** $250\n\n**Recipient:** Jane',
  );
  expect(toolApprovalPresentation({ body: '# Heading' })).toContain('**Body:**\n\n# Heading');
});

it('redacts secret fields and sensitive names before formatting, including nested arrays', () => {
  const result = toolApprovalPresentation(
    {
      value: 'private',
      api_key: 'hidden',
      rows: [{ password: 'nested', public: 'visible' }],
    },
    {
      fields: [
        { parameter: 'value', label: 'Value', presentation: 'secret' },
        { parameter: 'api_key', label: 'Renamed' },
        { parameter: 'rows' },
      ],
    },
  );
  for (const secret of ['private', 'hidden', 'nested']) expect(result).not.toContain(secret);
  expect(result.match(/\[redacted\]/g)).toHaveLength(3);
  expect(result).toContain('visible');
});

it('keeps unusual field names literal and does not read inherited parameters', () => {
  expect(toolApprovalPresentation({ 'a*b': 'ok' })).toContain('**A\\*b:** ok');
  expect(toolApprovalPresentation({}, { fields: [{ parameter: 'toString' }] })).toBe(
    'No parameters.',
  );
});
