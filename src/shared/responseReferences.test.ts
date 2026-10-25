import { describe, expect, it } from 'vitest';
import { artifactHref, parseResponseReference } from './responseReferences';

describe('Response file references', () => {
  it.each([
    ['mukai://artifact/abc-123#L42', { type: 'artifact', id: 'abc-123', line: 42 }],
    ['mukai://attachment/upload_1', { type: 'attachment', id: 'upload_1' }],
    ['mukai://file/reports%2Fmy%20chart.png', { type: 'file', path: 'reports/my chart.png' }],
    ['./reports/chart.png', { type: 'file', path: './reports/chart.png' }],
    [
      '/home/mukai/workspace/output.png',
      { type: 'file', path: '/home/mukai/workspace/output.png' },
    ],
    ['C:\\Workspace\\notes.md#L2', { type: 'file', path: 'C:\\Workspace\\notes.md', line: 2 }],
  ])('recognizes %s without guessing from prose', (href, result) =>
    expect(parseResponseReference(href)).toMatchObject(result),
  );
  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,x',
    'https://example.com/a.png',
    '//server/share',
    '\\\\server\\share',
    'mukai://artifact/a/b',
    'mukai://artifact/a%00',
    '%00secret',
    'mukai://other/id',
    'mukai://file/%ZZ',
    '#heading',
    '',
  ])('rejects %s', (href) => expect(parseResponseReference(href)).toBeNull());
  it('round trips a tool-generated reference', () =>
    expect(parseResponseReference(artifactHref('generated-id'))).toMatchObject({
      type: 'artifact',
      id: 'generated-id',
    }));
});
