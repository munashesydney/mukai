import { z } from 'zod';
export const botManagementDefinition = {
  name: 'manage_bot',
  title: 'Bots',
  summary: 'Inspect the workspace team, manage specialist bots, and delegate work.',
  actions: ['create', 'update', 'list', 'get', 'send_message'],
  description:
    'list returns IDs, roles, createdBy and hierarchyLevel (main=0); get requires botId and returns that workspace bot’s configuration. Only the main bot can create or update bots. create requires name, role, instructions; specialists inherit your provider/model. Reuse suitable existing bots; create a specialist when needed, avoiding duplicate purposes unless separate workers are useful. update requires botId and at least one of name, role, instructions, avatar, toolIds; omitted fields stay unchanged. Omitted toolIds on create grants your ordinary tools except pursuits; explicit toolIds replaces optional assignments. Bots access is mandatory and its actions depend on identity and run context. Grant only assigned tools; skills/routes stay shared. send_message requires botId,message; waits and returns response,status,conversationId. Reuse conversationId to continue that pair’s thread; omit for a new one. Message only workspace peers or lower-level bots, never yourself or higher-level bots. Sub-bots responding to another bot intentionally cannot send messages or delegate further. Final replies return automatically to the caller; no send_message back. Report completion only for status complete.',
  inputSchema: z.object({
    action: z.enum(['create', 'update', 'list', 'get', 'send_message']),
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
        'Optional complete tool assignment list: built-in tool names, or custom:<registrationId> from register_custom_tool list. terminal includes process; process is accepted as an alias for terminal. [] assigns no optional tools. Skills and routes remain shared.',
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
