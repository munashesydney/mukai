import { z } from 'zod';
import type { Bot, ChatActivity } from '../../../shared/ai';
import type { CapabilityService } from '../../capabilities/service';
import type { CapabilityKind } from '../../../shared/customCapabilities';
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
  'run_now',
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
export function registrationDescription(kind: CapabilityKind) {
  const contracts = {
    tool: 'Tools export {name,description,inputSchema (JSON Schema object),requiredEnv:[],timeoutMs?,execute(args,context)}. Register MUST include permissionMode: auto_approve runs immediately; ask_bot returns confirmation_required with pendingCallId before executing; user_approval waits for the user even in Full access. Choose for the actual effects; creating a tool does not authorize those effects. For an ask_bot checkpoint, review authorization then call confirm_custom_tool with pendingCallId and continue, ask_user_approval, or cancel. Do not resend the original call or bypass confirmation. Use set_permission with id and permissionMode to change policy. Module output is nested in a runtime receipt; its permission and execution fields determine what actually happened, not the inner output.',
    route:
      "Routes export {name,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD',path:'/custom/...',auth:'mukai'|'session'|'handler'|'public',requiredEnv:[],timeoutMs?,handle(request,context),processJob?(payload,context)}. Paths are exact with no trailing slash. Mukai hosts the route; do not open a listener. handle returns {status,headers?,body?}. request includes headers, rawBody bytes, and parsed JSON body if applicable. For handler auth, verify provider signatures against request.rawBody before effects or enqueue. mukai uses a workspace route bearer token; session uses Mukai owner login (page visits sign in and return, signed-out APIs get 401); its cookies are verified and stripped. Public routes are explicitly unauthenticated. Routes do not take permissionMode.",
    job: "Jobs export {name,description,triggers:[{type:'interval',intervalMs:300000},{type:'workspace_start'}],requiredEnv:[],timeoutMs?,run(event,context),processJob?(payload,context)}. Use interval and/or workspace_start with no duplicates, OR a single {type:'once',runAt:'2026-10-30T18:00:00Z'} trigger with an ISO timestamp. For once, choose the actual desired time (a past/current time runs when available). It is consumed on the first attempt, including run_now: no replay after restart, failure, disable/enable or code-only update. Change runAt in an update to explicitly rearm. A manual run_now is always a deliberate new invocation. intervalMs: integer 1000–31536000000. workspace_start runs once per runtime start, after the VM worker is ready or a connected folder workspace initializes in the backend. Registration/enabling during an existing runtime waits for the next start; use run_now with id to test now. event includes trigger (interval, workspace_start, once, manual), scheduledAt (ISO), and runtimeId for scheduled runs. Same-job executions never overlap. Missed intervals coalesce to one run when available. Jobs require the backend and workspace runtime; they do not boot stopped VMs. Failed/interrupted runs are recorded without automatic retries; later intervals/new starts still run. Registration enables unattended execution: keep effects within user authorization. Jobs do not take permissionMode. list/inspect include health.lastRun, consecutiveFailures and lastError; ready does not imply successful execution. Verify history/effects. run_now consumes a pending once schedule; use a disposable job for one-shot testing.",
  };
  return `Manage saved .ts/.js workspace ${kind} modules. Write the module first, then register/update with modulePath and exportName (default). Register generates an ID; use exact IDs from list/inspect for update/enable/disable/remove. Registrations are workspace-shared. ${contracts[kind]} Shared runtime/helper instructions are in your system context.`;
}
export async function executeRegistration(
  kind: CapabilityKind,
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
