import { z } from 'zod';

export const codeExecutionDefinition = {
  name: 'execute_code',
  title: 'Code Execution',
  summary: 'Call tools from JavaScript, process their responses, and return selected output.',
  actions: ['execute'],
  description:
    'Run isolated JavaScript with top-level await. Use await tools.NAME(input) with normal tool schemas; Object.keys(tools) lists available file_operations, web_search, browser, terminal and process tools. Internal structured responses bypass model-context truncation; underlying pagination and operational limits remain. Permissions, approvals and call budgets apply to every call. Only print(...) or console.log(...) output returns to the model under normal final-result limits. Check result.ok and normal response envelopes before selecting fields. Await every call; Promise.all supports independent work. Fresh state per call; no Node, imports, direct filesystem/network/environment access, recursion or delegation. timeoutMs excludes tool/approval waits. Failed scripts may have completed actions; verify activity before retrying.',
  inputSchema: z
    .object({
      code: z
        .string()
        .min(1)
        .max(120000)
        .describe(
          'JavaScript body with top-level await. Print only the results needed by the model.',
        ),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe(
          'Computation timeout in milliseconds, default 30000; tool/approval waits are excluded.',
        ),
    })
    .strict(),
};
export type CodeExecutionInput = z.infer<typeof codeExecutionDefinition.inputSchema>;

export const codeCallableTools = new Set([
  'file_operations',
  'web_search',
  'browser',
  'terminal',
  'process',
]);
