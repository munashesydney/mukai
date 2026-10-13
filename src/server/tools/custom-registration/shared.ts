import { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { CapabilityService } from '../../capabilities/service';
import { customToolPermissionModes } from '../../../shared/customCapabilities';

export const registrationActions = [
  'register',
  'update',
  'enable',
  'disable',
  'remove',
  'list',
  'inspect',
  'set_permission',
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
  permissionMode: z
    .enum(customToolPermissionModes)
    .optional()
    .describe(
      'Required when registering a custom tool: auto_approve executes immediately; ask_bot returns an expected confirmation checkpoint before execution; user_approval waits for the user even in Full access. Not used for routes.',
    ),
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
  return `Manage custom ${kind} modules saved as .ts/.js files in this workspace. Use operation register/update after writing or editing a file. To register, supply operation register, modulePath, and exportName (default). Custom tools MUST also specify permissionMode: auto_approve for actions that can run immediately, ask_bot for a deliberate bot review checkpoint, or user_approval for actions that must wait for the user. Routes do not take permissionMode. Use set_permission with id and permissionMode to change a custom tool policy. Choose based on what the tool does; split preparation and consequential actions into separate tools. Omit id: Mukai generates and returns the registration ID. For inspect/update/enable/disable/remove, use the exact ID returned by register or list, not the module name. When calling an ask_bot tool, expect confirmation_required with a pendingCallId and no execution. This is normal, not a failure or a denial. Call confirm_custom_tool with that ID and continue, ask_user_approval, or cancel; do not resend the original call. user_approval and escalated approval always wait for the user even in Full access. Modules export default objects. Tools: {name,description,inputSchema (JSON Schema object),requiredEnv:[],execute(args,context)}. Routes: {name,method,path:'/custom/...',auth:'mukai'|'handler'|'public',requiredEnv:[],handle(request,context),processJob?(payload,context)}. Read declared secrets only through context.env; never hard-code credentials or open a listener. Use context.signal with fetch. Return serializable results; routes return {status,headers?,body?}. To call or test a registered workspace route, use await context.callRoute(routeId, {body?, rawBody?, headers?, query?}) inside execute, handle or processJob. Get the exact route ID from register_custom_route list; method and path come from that registration. body is JSON; rawBody is exact UTF-8 text, and they are mutually exclusive. Returns {status,headers?,body?}; inspect status before claiming success. Mukai authorizes auth:mukai internally without exposing its API token; no token or host URL is needed. auth:handler still requires valid signature headers for the supplied rawBody. Requests are limited to 256 KB, calls inherit the parent lifetime, cycles are rejected, nesting is limited to four levels and each root invocation permits sixteen route calls. You can create and register a custom tool whose execute calls context.callRoute, then invoke that tool to test your route from chat, including in VM mode. Choose its permissionMode for the route's actual effects. Verify provider signatures against request.rawBody before work/enqueue. context.enqueue(provider,eventId,payload) durably deduplicates and queues processJob; context.wakeBot(message, {botId}) explicitly queues a wake-up of that workspace bot; omit the options to wake the owner bot. Bot-owned registrations may target their owner or peers/lower-level bots allowed by manage_bot; ownerless registrations require an explicit botId. Invalid targets fail without falling back. Await wakeBot to persist the job before acknowledging; it does not wait for the model response. Install dependencies in the workspace package setup before registration. Validation imports the module but never calls its handler; keep top-level code free of side effects. Code runs as trusted Node code with OS access. Names/configuration status are available; secret values are never available to you. Updates preserve the previous version on validation failure.`;
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
