import { z } from 'zod';

export const askDefinition = {
  name: 'ask',
  title: 'Ask',
  summary: 'Ask the user for clarification or an explicit approval and wait for their response.',
  actions: ['clarification', 'approval'],
  description:
    'Ask a focused question and wait for the user. clarification requires 2–6 distinct suggested options, each with a label, optional description, and recommended boolean; mark exactly one recommended. The user may choose an option or type their own answer. approval asks for an explicit yes/no decision about the question; omit options. A denied result may include the user’s reason in reason. These requests always wait for the user, even in Full access. A denial does not authorize the proposed action. Ask only when an answer or permission is needed; do not ask for tool permission already handled by the harness. The result contains the actual user answer or approval decision.',
  inputSchema: z
    .object({
      action: z.enum(['clarification', 'approval']),
      question: z.string().trim().min(1).max(2000),
      options: z
        .array(
          z
            .object({
              label: z.string().trim().min(1).max(200),
              description: z.string().trim().min(1).max(500).optional(),
              recommended: z.boolean(),
            })
            .strict(),
        )
        .min(2)
        .max(6)
        .optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
      if (input.action === 'approval' && input.options)
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'Approval requests do not have answer options.',
        });
      if (input.action === 'clarification') {
        if (!input.options || input.options.filter((option) => option.recommended).length !== 1)
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message:
              'Clarification requires suggested answers with exactly one recommended option.',
          });
        if (
          input.options &&
          new Set(input.options.map((option) => option.label.toLowerCase())).size !==
            input.options.length
        )
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'Suggested answers must be distinct.',
          });
      }
    }),
};
