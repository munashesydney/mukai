import { describe, expect, it } from 'vitest';
import { telegramFormatting } from './formatting';
import { telegramMessage } from './presentation';

describe('Telegram Markdown presentation', () => {
  it('renders internal file and image labels without exposing unusable Mukai URLs', () => {
    for (const body of [
      '[Report](mukai://artifact/report)',
      '![Screenshot](mukai://artifact/shot)',
    ]) {
      const result = telegramFormatting(telegramMessage(body, 'Project'));
      expect(result.text).toBe(
        'Workspace Project\n\n' + (body.startsWith('!') ? 'Screenshot' : 'Report'),
      );
      expect(result.entities?.some((entity) => entity.type === 'text_link')).toBe(false);
    }
  });
  it('formats emphasis, headings, code, links and lists with UTF-16 entity offsets', () => {
    const result = telegramFormatting(
      telegramMessage(
        '# Hello 📨\n\n- **Verify the plumbing**\n- *Harden it*\n\nUse `test_file` and [docs](https://example.com).\n\n```ts\nconst test = "<safe>";\n```',
        'Project',
        'Scout',
      ),
    );
    expect(result.text).toBe(
      'Workspace Project\nBot Scout\n\nHello 📨\n\n• Verify the plumbing\n• Harden it\n\nUse test_file and docs.\n\nconst test = "<safe>";',
    );
    const spans = result.entities!.map((entity) => ({
      type: entity.type,
      text: result.text.slice(entity.offset, entity.offset + entity.length),
    }));
    expect(spans).toEqual([
      { type: 'bold', text: 'Project' },
      { type: 'bold', text: 'Scout' },
      { type: 'bold', text: 'Hello 📨' },
      { type: 'bold', text: 'Verify the plumbing' },
      { type: 'italic', text: 'Harden it' },
      { type: 'code', text: 'test_file' },
      { type: 'text_link', text: 'docs' },
      { type: 'pre', text: 'const test = "<safe>";' },
    ]);
    expect(result.entities!.find((entity) => entity.type === 'pre')?.language).toBe('ts');
  });
  it('keeps labels and HTML literal and refuses unsafe links', () => {
    const result = telegramFormatting(
      telegramMessage(
        '**Hello** <b>literal</b> [bad](javascript:alert) [ok](https://example.com/?x=1&y=2)',
        '**Project**',
        '`Scout`',
      ),
    );
    expect(result.text).toContain(
      'Workspace **Project**\nBot `Scout`\n\nHello <b>literal</b> bad ok',
    );
    expect(result.entities?.filter((entity) => entity.type === 'text_link')).toEqual([
      expect.objectContaining({ url: 'https://example.com/?x=1&y=2' }),
    ]);
  });
  it('keeps plain and incomplete Markdown unchanged when there is nothing to format', () => {
    for (const body of [
      'Plain text. \n',
      '**Incomplete',
      '`Incomplete',
      'A harmless test in random-approval-test.txt',
    ]) {
      const text = telegramMessage(body, 'Project');
      expect(telegramFormatting(text)).toEqual({
        text,
        entities: [{ type: 'bold', offset: 10, length: 7 }],
      });
    }
  });
  it('resolves reference links without losing their destination', () => {
    const result = telegramFormatting(
      telegramMessage('See [the docs][ref].\n\n[ref]: https://example.com/docs', 'Project'),
    );
    expect(result.text).toBe('Workspace Project\n\nSee the docs.\n\n');
    expect(result.entities).toEqual([
      { type: 'bold', offset: 10, length: 7 },
      expect.objectContaining({ type: 'text_link', url: 'https://example.com/docs' }),
    ]);
  });
  it('avoids forbidden code nesting and leaves excessive formatting readable', () => {
    const result = telegramFormatting(
      telegramMessage('**Use `test` safely**\n\n> Outer\n> > Inner', 'Project'),
    );
    expect(result.entities?.filter((entity) => entity.type === 'bold')).toEqual([
      { type: 'bold', offset: 10, length: 7 },
    ]);
    expect(
      result.entities?.filter((entity) => entity.type === 'blockquote').length,
    ).toBeLessThanOrEqual(1);
    const dense = telegramMessage('**x** '.repeat(110), 'Project');
    expect(telegramFormatting(dense)).toEqual({
      text: dense,
      entities: [{ type: 'bold', offset: 10, length: 7 }],
    });
  });
  it('uses colon-free labels and bold values, without changing code or streamed body text', () => {
    const result = telegramFormatting(
      telegramMessage(
        'Update: A finding\nFrom: Research chat\nTool: computer_use\n\n```text\nBot: literal code\n```',
        'Project',
        'Scout',
      ),
    );
    expect(result.text).toBe(
      'Workspace Project\nBot Scout\n\nUpdate A finding\nFrom Research chat\nTool computer_use\n\nBot: literal code',
    );
    expect(
      result.entities
        ?.filter((entity) => entity.type === 'bold')
        .map((entity) => result.text.slice(entity.offset, entity.offset + entity.length)),
    ).toEqual(['Project', 'Scout', 'A finding', 'Research chat', 'computer_use']);
    const draft = telegramMessage('Still **typing', 'Project', 'Scout');
    expect(telegramFormatting(draft, false)).toMatchObject({
      text: draft,
      entities: [
        { type: 'bold', offset: 10, length: 7 },
        { type: 'bold', offset: 22, length: 5 },
      ],
    });
  });
});
