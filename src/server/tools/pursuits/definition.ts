import { z } from 'zod';

export const pursuitInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe('Required for create and update. Short pursuit name.'),
  objective: z
    .string()
    .trim()
    .min(1)
    .max(6000)
    .describe('Required for create and update. Goal to work toward.'),
  successCriteria: z
    .string()
    .trim()
    .min(1)
    .max(3000)
    .describe('Required for create and update. Concrete, verifiable conditions for completion.'),
  firstRunAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .default(null)
    .describe(
      'Optional next wake as an ISO timestamp with timezone. Null starts as soon as the scheduler is available.',
    ),
  deadline: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .default(null)
    .describe('Optional deadline as an ISO timestamp with timezone. Null means no deadline.'),
});
// Validate each action locally; providers require the model-facing root to be an object.
export const pursuitActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...pursuitInputSchema.shape }),
  z.object({
    action: z.literal('update'),
    pursuitId: z.string().uuid(),
    ...pursuitInputSchema.shape,
  }),
  z.object({ action: z.literal('list') }),
  z.object({ action: z.enum(['pause', 'resume', 'complete']), pursuitId: z.string().uuid() }),
]);
export const pursuitDefinition = {
  name: 'manage_pursuit',
  title: 'Pursuits',
  summary: 'Create and manage your scheduled pursuits.',
  actions: ['create', 'list', 'update', 'pause', 'resume', 'complete'],
  description:
    'Manage pursuits you own. Create only when the user asks for ongoing work. You are the sole owner; ownership cannot be assigned or transferred. Specify an objective, concrete success criteria, optional firstRunAt and deadline as ISO dates with timezone (null when omitted). Without firstRunAt the first run starts as soon as the scheduler is available. There is no recurring interval: each run must report its own next wake time, reason, and instructions using report_pursuit. Update requires all configuration fields. List returns pursuit IDs, state and run summaries. A pursuit executes in its own conversation on the local server while Mukai is running. Pausing stops an active run; resume schedules a run immediately to reassess and plan its next wake. Completing stops future wakes. Never claim a pursuit was created unless this tool succeeds.',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'update', 'pause', 'resume', 'complete']),
    pursuitId: z
      .string()
      .uuid()
      .optional()
      .describe('Required for update, pause, resume, complete.'),
    ...pursuitInputSchema.partial().shape,
  }),
};
