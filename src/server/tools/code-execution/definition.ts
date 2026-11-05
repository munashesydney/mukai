import { z } from 'zod';
import { MAX_CODE_OUTPUT_BYTES } from './runtime';

export const codeExecutionDefinition = {
  name: 'execute_code',
  title: 'Code Execution',
  summary: 'Call tools from JavaScript, process their responses, and return selected output.',
  actions: ['execute'],
  description:
    'Run isolated JavaScript with top-level await. Use await tools.NAME(input) with normal tool schemas. Object.keys(tools) lists available file_operations, web_search, browser, terminal and process tools. Internal results bypass model-context truncation and retain normal pagination, limits, permissions and approvals. Print selected fields with print(...) or console.log(...). Check each response for failure and validate expected fields before aggregating. Missing fields are errors. Local file results are flat while VM file results are under result. Await all calls. Promise.all supports independent work. Each run starts fresh with no Node, imports, direct filesystem/network/environment access, recursion or delegation. timeoutMs excludes tool and approval waits. Verify completed actions before retrying a failed script.\n\n' +
    'For a web batch, set maxOutputBytes to 2048 and use this pattern.\n```js\n' +
    `const queries = ['solar energy storage', 'wind energy storage'];
const r = await tools.web_search({action: 'search', queries, maxResults: 2});
if (!r.ok) throw new Error(r.error ?? r.summary ?? 'Search failed');
const items = r.result?.items;
if (!Array.isArray(items) || items.length !== queries.length) throw new Error('Unexpected search batch');
for (const item of items) {
  if (item.ok === false) {
    print({query: item.target, error: item.error});
    continue;
  }
  if (item.ok !== true || !Array.isArray(item.sources)) throw new Error('Unexpected search item');
  print({query: item.target, sources: item.sources.map(({title, url}) => ({title, url}))});
}
\`\`\``,
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
      maxOutputBytes: z
        .number()
        .int()
        .min(256)
        .max(MAX_CODE_OUTPUT_BYTES)
        .optional()
        .describe('UTF-8 print budget. Use a smaller budget for summaries. Default 96000.'),
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
