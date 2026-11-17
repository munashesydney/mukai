import { z } from 'zod';

export const memoryOrigins = [
  'user_message',
  'assistant_report',
  'tool_output',
  'legacy_memory',
] as const;
export const compactionSections = [
  ['objective', 'Objective'],
  ['requirements', 'Requirements'],
  ['decisions', 'Decisions'],
  ['completed', 'Completed'],
  ['active', 'Active'],
  ['blocked', 'Blocked'],
  ['next', 'Next steps'],
  ['relevant_files', 'Relevant files'],
  ['pitfalls', 'Errors and pitfalls'],
  ['context', 'Important context'],
] as const;
export const compactionSectionSchema = z.enum(compactionSections.map(([key]) => key));
export const compactionEvidenceSchema = z
  .object({ origin: z.enum(memoryOrigins), quote: z.string().min(1).max(400) })
  .strict();
export const handoverEntrySchema = z
  .object({
    section: compactionSectionSchema,
    note: z.string().trim().min(1),
    evidence: z.array(compactionEvidenceSchema).min(1).max(4),
  })
  .strict();
export const compactionNotebookSchema = z.discriminatedUnion('version', [
  z
    .object({
      version: z.literal(1),
      entries: z.array(
        z.object({ origin: z.enum(memoryOrigins), note: z.string(), quote: z.string() }).strict(),
      ),
    })
    .strict(),
  z.object({ version: z.literal(2), entries: z.array(handoverEntrySchema) }).strict(),
]);
export type CompactionNotebook = z.infer<typeof compactionNotebookSchema>;
