import { skillsDefinition } from './skills/definition';
import { tool, type ToolSet } from 'ai';
import { fileOperationsDefinition } from './file-operations/definition';
import { executeFileOperations } from './file-operations/execute';
import type { ToolContext, ToolScope } from './types';
import { pursuitDefinition } from './pursuits/definition';
import { executePursuit } from './pursuits/execute';
import { terminalDefinition, processDefinition } from './terminal/definition';
import { executeTerminal, executeProcess } from './terminal/execute';
import { browserDefinition } from './browser/definition';
import { executeBrowser } from './browser/execute';
import type { RuntimeToolContext } from './runtimeContext';
import type { ProcessService } from '../services/processService';
import type { BrowserService } from '../services/browserService';
import { resultPreview } from '../services/toolResultPolicy';
import { registerCustomToolDefinition } from './register-custom-tool/definition';
import { executeRegisterCustomTool } from './register-custom-tool/execute';
import { registerCustomRouteDefinition } from './register-custom-route/definition';
import { executeRegisterCustomRoute } from './register-custom-route/execute';
import type { RegistrationContext } from './custom-registration/shared';
import { memoryDefinition } from './memory/definition';
import { communicateDefinition } from './communicate/definition';
import { conversationsDefinition } from './conversations/definition';
import { botManagementDefinition } from './bots/definition';
import { executeBotManagement } from './bots/execute';
import { webSearchDefinition } from './web-search/definition';
import { executeWebSearch } from './web-search/execute';
import type { WebSearchService } from '../services/webSearchService';
import { imageDefinition } from './image/definition';
import { imageTools } from './image/execute';

export function botManagementTools(context: Parameters<typeof executeBotManagement>[1]): ToolSet {
  const actions = context.management.actionsFor(context.bot, context.messageId);
  return {
    [botManagementDefinition.name]: tool({
      description:
        `Available actions for this run: ${actions.join(', ')}. ` +
        botManagementDefinition.description,
      inputSchema: botManagementDefinition.inputSchema.extend({
        action: botManagementDefinition.inputSchema.shape.action.extract(actions),
      }),
      execute: (input, options) => executeBotManagement(input, context, options.toolCallId),
    }),
  };
}

export function customRegistrationTools(context: RegistrationContext): ToolSet {
  return {
    [registerCustomToolDefinition.name]: tool({
      description: registerCustomToolDefinition.description,
      inputSchema: registerCustomToolDefinition.inputSchema,
      execute: (input, options) => executeRegisterCustomTool(input, context, options.toolCallId),
    }),
    [registerCustomRouteDefinition.name]: tool({
      description: registerCustomRouteDefinition.description,
      inputSchema: registerCustomRouteDefinition.inputSchema,
      execute: (input, options) => executeRegisterCustomRoute(input, context, options.toolCallId),
    }),
  };
}

export function runtimeTools(
  context: RuntimeToolContext & {
    processes: ProcessService;
    browsers: BrowserService;
    webSearch: WebSearchService;
    folder: string | null;
    vision: boolean;
    saveScreenshot?: Parameters<typeof executeBrowser>[1]['saveScreenshot'];
  },
): ToolSet {
  return {
    ...imageTools(context),
    web_search: tool({
      description: webSearchDefinition.description,
      inputSchema: webSearchDefinition.inputSchema,
      execute: (input, options) =>
        executeWebSearch(
          input,
          {
            ...context,
            signal: options.abortSignal
              ? AbortSignal.any([context.signal, options.abortSignal])
              : context.signal,
          },
          options.toolCallId,
        ),
      toModelOutput: ({ output }) => ({
        type: 'text',
        value: resultPreview(output, context.resultBytes ?? 96000),
      }),
    }),
    ...(context.folder
      ? {
          terminal: tool({
            description: terminalDefinition.description,
            inputSchema: terminalDefinition.inputSchema,
            execute: (input, options) =>
              executeTerminal(input, { ...context, folder: context.folder! }, options.toolCallId),
          }),
          process: tool({
            description: processDefinition.description,
            inputSchema: processDefinition.inputSchema,
            execute: (input, options) => executeProcess(input, context, options.toolCallId),
          }),
        }
      : {}),
    browser: tool({
      description: browserDefinition.description,
      inputSchema: browserDefinition.inputSchema,
      execute: (input, options) => executeBrowser(input, context, options.toolCallId),
      toModelOutput: ({ output }) => {
        const result = output.result;
        if (
          result &&
          typeof result === 'object' &&
          'image' in result &&
          typeof result.image === 'string'
        ) {
          const { image, ...rest } = result;
          return context.vision
            ? {
                type: 'content',
                value: [
                  {
                    type: 'text',
                    text: resultPreview(
                      {
                        ...output,
                        result: { ...rest, imageIncluded: true, imageDelivery: 'included' },
                      },
                      context.resultBytes ?? 96000,
                    ),
                  },
                  { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
                ],
              }
            : {
                type: 'text',
                value: resultPreview(
                  {
                    ...output,
                    result: {
                      ...rest,
                      imageIncluded: false,
                      imageDelivery: 'unsupported',
                      notice:
                        'Screenshot saved. Choose a vision model to inspect the image pixels.',
                    },
                  },
                  context.resultBytes ?? 96000,
                ),
              };
        }
        return { type: 'text', value: resultPreview(output, context.resultBytes ?? 96000) };
      },
    }),
  };
}

export function pursuitTools(context: Parameters<typeof executePursuit>[1]): ToolSet {
  return {
    [pursuitDefinition.name]: tool({
      description: pursuitDefinition.description,
      inputSchema: pursuitDefinition.inputSchema,
      execute: (input, options) => executePursuit(input, context, options.toolCallId),
    }),
  };
}

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
  return [
    ...registrations.map(({ definition, scope }) => ({
      id: definition.name,
      name: definition.title,
      description: definition.summary,
      actions: definition.actions,
      scope: scope.type,
    })),
    {
      id: pursuitDefinition.name,
      name: pursuitDefinition.title,
      description: pursuitDefinition.summary,
      actions: pursuitDefinition.actions,
      scope: 'all-bots' as const,
    },
    ...[
      terminalDefinition,
      botManagementDefinition,
      browserDefinition,
      imageDefinition,
      webSearchDefinition,
      registerCustomToolDefinition,
      registerCustomRouteDefinition,
      memoryDefinition,
      communicateDefinition,
      conversationsDefinition,
      skillsDefinition,
    ].map((definition) => ({
      id: definition.name,
      name: definition.title,
      description: definition.summary,
      actions: definition.actions,
      scope: 'all-bots' as const,
    })),
  ];
}
