import { z } from 'zod';

export const systemDefinition = {
  name: 'system',
  title: 'System',
  summary:
    'Workspace facts and response control: list environment variable names or explicitly stop generation.',
  actions: ['list_env_vars', 'stop_generation'],
  description:
    'Workspace facts and response control. stop_generation explicitly ends only your current response without another model generation. Call it by itself when you intentionally want to finish, including after a nudge because your final text matched your reasoning. Optional finalResponse supplies your final answer; otherwise Mukai preserves the latest visible text. Completed operations are saved; this does not shut down Mukai, the VM, other chats, or running processes. Pending operations must settle, and newer user guidance and required outcome reporting still take priority. list_env_vars is read-only and lists variable names saved in Settings → Environment Variables with configured (a non-empty value exists) and usedBy (capabilities declaring it in requiredEnv). Values are never returned, so consume a variable by name through terminal envFromSettings or a capability requiredEnv instead of asking the user to paste it. Results are ordered by name and paged with limit (default 25, max 100) and offset over the filtered list: total counts every variable, matched counts the filter, and nextOffset is null on the last page. query is a case-insensitive substring of a name or capability name. Check here before a run instead of waiting for a missing-variable error, and tell the user to save any configured:false name in Settings.',
  inputSchema: z.object({
    action: z.enum(['list_env_vars', 'stop_generation']),
    finalResponse: z
      .string()
      .trim()
      .min(1)
      .max(64000)
      .optional()
      .describe(
        'Optional final answer for stop_generation. Ends this response after saving completed work.',
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive text in a variable name or the capability that declares it.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size, default 25.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe('Offset into the filtered list, default 0.'),
  }),
};
export type SystemInput = z.infer<typeof systemDefinition.inputSchema>;
