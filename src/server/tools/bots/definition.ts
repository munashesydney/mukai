import { z } from 'zod';
export const botManagementDefinition = {
  name: 'manage_bot',
  title: 'Bots',
  summary: 'Create specialist bots and message peers or bots below you in the hierarchy.',
  actions: ['create', 'list', 'send_message'],
  description:
    'list returns IDs, roles, createdBy and hierarchyLevel (main=0). create requires name, role, instructions; children inherit your provider/model and record you as creator. Omitted toolIds grants your ordinary tools including Bots, excluding pursuits; explicit toolIds replaces defaults. Grant only assigned tools; skills/routes stay shared. send_message requires botId,message; waits and returns response,status,conversationId. Reuse conversationId to continue that pair’s thread; omit for a new one. Message only workspace peers or lower-level bots, never yourself or higher-level bots. Final replies return automatically to the caller; no send_message back. Report completion only for status complete.',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'send_message']),
    name: z.string().trim().min(1).max(60).optional(),
    role: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Required for create: the bot’s job, for example Code architect.'),
    instructions: z.string().trim().min(1).max(12000).optional(),
    avatar: z.enum(['scout', 'nova', 'atlas']).optional(),
    toolIds: z
      .array(z.string().min(1).max(100))
      .max(100)
      .optional()
      .describe(
        'Optional complete tool assignment list: built-in tool names, or custom:<registrationId> from register_custom_tool list. [] assigns no optional tools. Skills and routes remain shared.',
      ),
    botId: z.string().min(1).max(80).optional(),
    message: z.string().trim().min(1).max(16000).optional(),
    conversationId: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('Continue this two-bot thread; omit for a new one.'),
  }),
};
