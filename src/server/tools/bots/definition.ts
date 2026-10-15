import { z } from 'zod';
export const botManagementDefinition = {
  name: 'manage_bot',
  title: 'Bots',
  summary: 'Inspect the workspace team, manage specialist bots, and delegate work.',
  actions: ['create', 'update', 'list', 'get', 'send_message', 'get_last_message'],
  description:
    'list returns IDs, roles, createdBy and hierarchyLevel (main=0); get requires botId and returns that workspace bot’s configuration. Only the main bot can create or update bots. create requires name, role, instructions; specialists inherit your provider/model. Reuse suitable existing bots; create a specialist when needed, avoiding duplicate purposes unless separate workers are useful. update requires botId and at least one of name, role, instructions, toolIds; omitted fields stay unchanged. Omitted toolIds on create grants your ordinary tools except pursuits; explicit toolIds replaces optional assignments. Bots access is mandatory and its actions depend on identity and run context. Grant only assigned tools; skills/routes stay shared. send_message requires botId,message,mode. mode must be fire_and_forget or wait: fire_and_forget starts independent work and returns conversationId,requestId,messageId,status immediately; wait returns the saved final response,status,conversationId. get_last_message requires botId,conversationId and returns the target bot’s latest reply with requestId,messageId,status,response,error; it does not wait. After fire_and_forget, do other work or wait before checking; compare requestId to your dispatch. streaming means still working. Reuse conversationId to continue that pair’s thread; omit for a new one. Message only workspace peers or lower-level bots, never yourself or higher-level bots. Sub-bots responding to another bot intentionally cannot send messages or delegate further. Final replies return automatically to the caller; no send_message back. Report completion only for status complete.',
  inputSchema: z
    .object({
      action: z.enum(['create', 'update', 'list', 'get', 'send_message', 'get_last_message']),
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
    }),
};
