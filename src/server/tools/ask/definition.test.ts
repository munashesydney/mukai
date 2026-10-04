import { describe, expect, it } from 'vitest';
import { askDefinition } from './definition';

const question = {
  action: 'clarification',
  question: 'Which audience?',
  options: [
    { label: 'New customers', recommended: true },
    { label: 'Existing customers', description: 'Focus on retention.', recommended: false },
  ],
};
describe('Ask tool schema', () => {
  it('requires distinct suggestions and exactly one recommendation for clarification', () => {
    expect(askDefinition.inputSchema.safeParse(question).success).toBe(true);
    for (const options of [
      undefined,
      [],
      [question.options[0]],
      question.options.map((option) => ({ ...option, recommended: false })),
      question.options.map((option) => ({ ...option, recommended: true })),
      [question.options[0], { ...question.options[1], label: 'new customers' }],
    ])
      expect(askDefinition.inputSchema.safeParse({ ...question, options }).success).toBe(false);
  });
  it('validates a focused approval question without suggestions', () => {
    expect(
      askDefinition.inputSchema.parse({ action: 'approval', question: ' Publish this? ' }),
    ).toEqual({ action: 'approval', question: 'Publish this?' });
    for (const input of [
      { action: 'approval', question: ' ' },
      { ...question, action: 'approval' },
      { ...question, action: 'unexpected' },
    ])
      expect(askDefinition.inputSchema.safeParse(input).success).toBe(false);
  });
});
