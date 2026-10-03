import { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { CapabilityService } from '../../capabilities/service';

export const registrationActions = [
  'register',
  'update',
  'enable',
  'disable',
  'remove',
  'list',
  'inspect',
] as const;
export const registrationInput = z.object({
  operation: z.enum(registrationActions),
  id: z
    .string()
    .max(100)
    .describe(
      'Existing registration ID returned by register or list. Only used for inspect, update, enable, disable, and remove; ignored by register.',
    )
    .optional(),
  modulePath: z.string().min(1).max(512).optional(),
  exportName: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/)
    .default('default'),
});
export interface RegistrationContext {
  bot: Bot;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
  capabilities: CapabilityService;
}
export function registrationDescription(kind: 'tool' | 'route') {
  return `Manage custom ${kind} modules saved as .ts/.js files in this workspace. Use operation register/update after writing or editing a file. To register, supply operation register, modulePath, and exportName (default). Omit id: Mukai generates and returns the registration ID. For inspect/update/enable/disable/remove, use the exact ID returned by register or list, not the module name. Modules export default objects. Tools: {name,description,inputSchema (JSON Schema object),requiredEnv:[],execute(args,context)}. Routes: {name,method,path:'/custom/...',auth:'mukai'|'handler'|'public',requiredEnv:[],handle(request,context),processJob?(payload,context)}. Read declared secrets only through context.env; never hard-code credentials or open a listener. Use context.signal with fetch. Return serializable results; routes return {status,headers?,body?}. Verify provider signatures against request.rawBody before work/enqueue. context.enqueue(provider,eventId,payload) durably deduplicates and queues processJob; context.wakeBot(message) explicitly queues a wake-up of the owner bot. Install dependencies in the workspace package setup before registration. Validation imports the module but never calls its handler; keep top-level code free of side effects. Code runs as trusted Node code with OS access. Names/configuration status are available; secret values are never available to you. Updates preserve the previous version on validation failure.`;
}
export async function executeRegistration(
  kind: 'tool' | 'route',
  input: z.infer<typeof registrationInput>,
  context: RegistrationContext,
  toolCallId: string,
) {
  const { bot, signal, onActivity, capabilities } = context;
  const activity: ChatActivity = {
    id: toolCallId,
    tool: 'register_custom_' + kind,
    action: input.operation,
    path: input.modulePath || input.id || '',
    status: 'running',
    summary: 'Managing custom capability',
  };
  onActivity(activity);
  try {
    const result = await capabilities.manage(bot.workspaceId, bot.id, kind, input, signal);
    onActivity({
      ...activity,
      status: 'complete',
      summary: 'Custom capability ' + input.operation + ' completed.',
    });
    return result;
  } catch (error) {
    const summary = capabilities.environment
      .redact(error instanceof Error ? error.message : String(error))
      .slice(0, 2000);
    onActivity({ ...activity, status: 'failed', summary });
    throw error;
  }
}
