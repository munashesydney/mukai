import { z } from 'zod';

export const environmentVariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const terminalEnvironmentFields = {
  envFromSettings: z
    .array(environmentVariableName)
    .max(100)
    .optional()
    .describe(
      'Saved workspace variable names for this run and its children. Missing/empty names fail before launch.',
    ),
  env: z
    .record(
      environmentVariableName,
      z
        .string()
        .max(16384)
        .refine((value) => !value.includes('\0')),
    )
    .refine((value) => Object.keys(value).length <= 100)
    .optional()
    .describe('Temporary nonsecret values. No overlap with envFromSettings.'),
};
export const terminalSnapshotSchema = z.object({
  id: z.string().uuid(),
  command: z.string(),
  cwd: z.string(),
  shell: z.string().optional(),
  status: z.enum(['running', 'exited', 'killed', 'failed']),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  createdAt: z.string(),
  envFromSettings: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
  nextOffset: z.number().optional(),
  unavailable: z.boolean().optional(),
});
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;

export function missingEnvironmentError(names: string[]) {
  return `Missing or empty workspace environment variables: ${names.join(', ')}. Add them in Settings → Environment Variables, then retry. No command was started.`;
}
