import { tool, type ToolSet } from 'ai';
import { fileOperationsDefinition } from './file-operations/definition';
import { executeFileOperations } from './file-operations/execute';
import type { ToolContext, ToolScope } from './types';

// New tool families add their own definition/execute folder and register here.
// A scope can target bot IDs without changing the chat runtime.
const registrations = [
  {
    definition: fileOperationsDefinition,
    scope: { type: 'all-bots' } as ToolScope,
    create: (context: ToolContext) =>
      tool({
        description: fileOperationsDefinition.description,
        inputSchema: fileOperationsDefinition.inputSchema,
        execute: (input, options) =>
          executeFileOperations(
            input,
            {
              ...context,
              signal: options.abortSignal
                ? AbortSignal.any([context.signal, options.abortSignal])
                : context.signal,
            },
            options.toolCallId,
          ),
      }),
  },
];
export function toolsForBot(context: ToolContext): ToolSet {
  const tools: ToolSet = {};
  for (const registration of registrations) {
    if (registration.scope.type === 'all-bots' || registration.scope.botIds.includes(context.botId))
      tools[registration.definition.name] = registration.create(context);
  }
  return tools;
}
export function toolCatalog() {
  return registrations.map(({ definition, scope }) => ({
    id: definition.name,
    name: definition.title,
    description: definition.summary,
    actions: definition.actions,
    scope: scope.type,
  }));
}
