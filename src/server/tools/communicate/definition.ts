import { z } from 'zod';
import { askDefinition } from '../ask/definition';

export const communicateDefinition = {
  name: 'communicate',
  title: 'Communicate',
  summary: 'Ask for clarification or approval, or send the user an autonomous work update.',
  actions: ['clarification', 'approval', 'notify'],
  description:
    'Communicate with the user. clarification and approval wait for an actual user response, even in Full access. ' +
    askDefinition.description +
    ' notify sends a persistent update to the workspace notification inbox without waiting or interrupting work. Use title and message (Markdown) for notify; omit question/options. Use it when autonomous work produces a meaningful finding, result, blocker, or decision the user should know about; avoid routine progress spam. A final pursuit response/report alone is not a notification. Notification delivery does not mean the user has read it or approved anything.',
  inputSchema: z
    .object({
      action: z.enum(['clarification', 'approval', 'notify']),
      question: askDefinition.inputSchema.shape.question.optional(),
      options: askDefinition.inputSchema.shape.options,
      title: z.string().trim().min(1).max(160).optional(),
      message: z.string().trim().min(1).max(16000).optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
      if (input.action === 'notify') {
        if (
          !input.title ||
          !input.message ||
          input.question !== undefined ||
          input.options !== undefined
        )
          ctx.addIssue({ code: 'custom', message: 'notify requires title and message only.' });
      } else {
        if (input.title !== undefined || input.message !== undefined)
          ctx.addIssue({ code: 'custom', message: 'Questions do not take notification fields.' });
        const parsed = askDefinition.inputSchema.safeParse({
          action: input.action,
          question: input.question,
          options: input.options,
        });
        if (!parsed.success)
          for (const issue of parsed.error.issues)
            ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }),
};
