import { z } from 'zod';
export const botManagementDefinition = {
  name: 'manage_bot',
  title: 'Bots',
  summary: 'Inspect the workspace team, manage specialist bots, and delegate work.',
  actions: [
    'create',
    'update',
    'delete',
    'list',
    'get',
    'list_models',
    'get_model',
    'send_message',
    'get_last_message',
  ],
  description:
    'list returns IDs, roles, createdBy, hierarchyLevel (main=0), and effective model settings; get requires botId and returns that workspace bot’s configuration. list/get/create/update report the resolved provider/model, inputCapabilities, supportsText/Images/Audio/Video, configured context/output limits, and reasoning effort or default behavior, including inherited settings. Media flags describe inputs the bot can inspect, not media generation. Unknown settings are explicitly labeled unknown or Not configured. Only the main bot can create, update, or delete bots. delete requires botId and permanently removes another idle workspace bot and its saved data; the main bot cannot delete itself. Bots with child bots must have their children removed first. list_models returns configured models and capabilities with unique selection IDs; get_model requires modelId from list_models. These actions are read-only. create requires name, role, instructions and optionally modelId from list_models. Creating without modelId defaults to the creator’s current model. Creation tests the selected provider/model connection first; a failed test returns an error without creating a bot. Reuse suitable existing bots; create a specialist when needed, avoiding duplicate purposes unless separate workers are useful. update requires botId and at least one of name, role, instructions, toolIds, modelId. Changing modelId tests the selected connection before applying any changes; failed tests leave the bot unchanged. Stop an active bot before editing it. Existing conversations are preserved and the next response uses the new model. Omitted fields stay unchanged. Omitted toolIds on create grants your ordinary tools except pursuits; explicit toolIds replaces optional assignments. Bots access is mandatory and its actions depend on identity and run context. Grant only assigned tools; skills/routes stay shared. send_message requires botId,message,mode. mode must be fire_and_forget or wait: fire_and_forget starts independent work and returns conversationId,requestId,messageId,status immediately; wait returns the saved final response,status,conversationId. get_last_message requires botId,conversationId and returns the target bot’s latest reply with requestId,messageId,status,response,error; it does not wait. After fire_and_forget, do other work or wait before checking; compare requestId to your dispatch. streaming means still working. Reuse conversationId to continue that pair’s thread; omit for a new one. Message only workspace peers or lower-level bots, never yourself or higher-level bots. Sub-bots responding to another bot intentionally cannot send messages or delegate further. Final replies return automatically to the caller; no send_message back. Report completion only for status complete.',
  inputSchema: z
    .object({
      action: z.enum([
        'create',
        'update',
        'delete',
        'list',
        'get',
        'list_models',
        'get_model',
        'send_message',
        'get_last_message',
      ]),
      name: z.string().trim().min(1).max(60).optional(),
      role: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('Required for create: the bot’s job, for example Code architect.'),
      instructions: z
        .string()
        .trim()
        .min(1)
        .max(12000)
        .optional()
        .describe(
          'The bot’s persistent system prompt: its role, approach, and standards across conversations. Put the specific task and current context in send_message.message. For example, create a QA specialist with instructions to verify behavior, test edge cases, and report reproducible defects; then message it to QA the features screen.',
        ),
      toolIds: z
        .array(z.string().min(1).max(100))
        .max(100)
        .optional()
        .describe(
          'Optional complete tool assignment list: built-in tool names, or custom:<registrationId> from register_custom_tool list. terminal includes process; process is accepted as an alias for terminal. [] assigns no optional tools. Skills and routes remain shared.',
        ),
      botId: z.string().min(1).max(80).optional(),
      modelId: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Configured model selection ID returned by list_models; required for get_model, optional for create or update. Omit on create to use the creator’s current model; omit on update to keep the bot’s current model.',
        ),
      message: z.string().trim().min(1).max(16000).optional(),
      mode: z
        .enum(['fire_and_forget', 'wait'])
        .optional()
        .describe(
          'Required for send_message: fire_and_forget starts work and returns immediately; wait returns the final reply.',
        ),
      conversationId: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe(
          'Required for get_last_message. For send_message, continue this two-bot thread or omit for a new one.',
        ),
    })
    .refine((input) => input.action !== 'send_message' || Boolean(input.mode), {
      message: 'send_message requires mode: fire_and_forget or wait.',
      path: ['mode'],
    })
    .refine((input) => input.action !== 'get_model' || Boolean(input.modelId), {
      message: 'get_model requires modelId from list_models.',
      path: ['modelId'],
    })
    .refine((input) => !input.modelId || ['create', 'update', 'get_model'].includes(input.action), {
      message: 'modelId is supported only for create, update, and get_model.',
      path: ['modelId'],
    }),
};
