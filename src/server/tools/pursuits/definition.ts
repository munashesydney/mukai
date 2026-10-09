import { z } from 'zod';
import {
  workpadEntrySchema,
  workpadPatchSchema,
  workpadQuerySchema,
  workpadFields,
  workpadGuidance,
} from './workpad';
import { workpadEntryTypes } from '../../../shared/pursuits';

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
  z.object({
    action: z.literal('list_entries'),
    pursuitId: z.string().uuid(),
    ...workpadQuerySchema.shape,
  }),
  z.object({
    action: z.literal('get_entry'),
    pursuitId: z.string().uuid(),
    entryId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('add_entry'),
    pursuitId: z.string().uuid(),
    entry: workpadEntrySchema,
  }),
  z.object({
    action: z.literal('update_entry'),
    pursuitId: z.string().uuid(),
    entryId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    patch: workpadPatchSchema,
  }),
]);
const actions = [
  'create',
  'list',
  'update',
  'pause',
  'resume',
  'complete',
  'list_entries',
  'get_entry',
  'add_entry',
  'update_entry',
] as const;
export const pursuitDefinition = {
  name: 'manage_pursuit',
  title: 'Pursuits',
  summary: 'Create and manage your scheduled pursuits.',
  actions: [...actions],
  description:
    'Manage pursuits you own. Create only when the user asks for ongoing work. You are the sole owner; ownership cannot be assigned or transferred. Specify an objective, concrete success criteria, optional firstRunAt and deadline as ISO dates with timezone (null when omitted). Without firstRunAt the first run starts as soon as the scheduler is available. There is no recurring interval: each run must report its own next wake time, reason, and instructions using report_pursuit. Update requires all configuration fields. List returns pursuit IDs, state and run summaries. A pursuit executes in its own conversation on the local server while Mukai is running. Pausing stops an active run; resume schedules a run immediately to reassess and plan its next wake. Completing stops future wakes. Never claim a pursuit was created unless this tool succeeds. Workpad actions require pursuitId. list_entries supports type/status/includeArchived and limit/offset with nextOffset pagination. get_entry requires entryId. add_entry requires entry {type,title,content,status?,links?}. Work items use todo/in_progress/done (default todo); blockers use open/resolved (default open); decision/reference/note use active (default). Any type may be archived. Links use {kind:file|url|conversation|artifact|entry,target,label}; file targets are workspace paths, URLs are HTTP(S), other targets are IDs. Entry links must refer to this pursuit. update_entry requires entryId, expectedRevision from retrieval, and patch {title?,content?,status?,links?}; supplied links replace all links, [] clears them. Types cannot change. Updates persist immediately, independently of the run outcome. ' +
    workpadGuidance,
  inputSchema: z.object({
    action: z.enum(actions),
    pursuitId: z
      .string()
      .uuid()
      .optional()
      .describe('Required for update, pause, resume, complete and all Workpad actions.'),
    ...pursuitInputSchema.partial().shape,
    entryId: z.string().uuid().optional(),
    expectedRevision: z.number().int().min(1).optional(),
    entry: z.object({ type: z.enum(workpadEntryTypes), ...workpadFields }).optional(),
    patch: z.object(workpadFields).partial().optional(),
    type: workpadQuerySchema.shape.type,
    status: workpadQuerySchema.shape.status,
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).max(100000).optional(),
  }),
};
