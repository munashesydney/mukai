import { z } from 'zod';
export const botManagementDefinition = {
  name: 'manage_bot',
  title: 'Bots',
  summary: 'Create specialist bots and delegate work down your bot hierarchy.',
  actions: ['create', 'list', 'spawn'],
  description:
    'Create and coordinate bots in your workspace. list returns bot IDs, roles, and creator relationships. create requires name, role, and instructions. Give the bot an actual human or bot-sounding name (Ada, Nova); put job titles (Code architect) in role. Avatar and toolIds are optional. Omitted toolIds grants ordinary tools you have, excluding pursuits and bot management. You can grant only assigned tools; skills and routes stay shared. A child inherits your provider/model. You are its creator, above it in the hierarchy. spawn requires botId and message: sends work to a descendant in a saved conversation and waits for its response. You cannot spawn yourself, ancestors, peers, or other workspaces. Report completion only when returned status is complete.',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'spawn']),
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
  }),
};
