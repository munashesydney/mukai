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
  'set_presentation',
  'run_now',
] as const;
export const toolPresentation = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    fields: z
      .array(
        z
          .object({
            parameter: z.string().min(1).max(512),
            label: z.string().trim().min(1).max(200).optional(),
            presentation: z.enum(['text', 'long_text', 'secret']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (fields) => new Set(fields.map((field) => field.parameter)).size === fields.length,
        'Each parameter may appear only once.',
      )
      .optional(),
  })
  .strict();
export const registrationInput = z.object({
  operation: z.enum(registrationActions),
  id: z
    .string()
    .max(100)
    .describe('Existing registration ID from list/inspect; ignored by register.')
    .optional(),
  modulePath: z.string().min(1).max(512).optional(),
  permissionMode: z
    .enum(customToolPermissionModes)
    .optional()
    .describe(
      'Required for tool registration: auto_approve runs immediately; ask_bot pauses for bot confirmation; user_approval waits for the user even in Full access.',
    ),
  presentation: toolPresentation
    .nullable()
    .optional()
    .describe(
      'Mukai/Telegram approval layout. fields selects/orders exact top-level parameters; omit to show all. text/long_text and title support Markdown; secret redacts. Set on register/update or set_presentation with id; null resets.',
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
    tool: 'Tools export {name,description,inputSchema (object JSON Schema),requiredEnv:[],timeoutMs?,execute(args,context)}. Register requires permissionMode matching the actual effects; creating a tool does not authorize those effects. For ask_bot checkpoints follow confirm_custom_tool instructions; never resend the original call to confirm. set_permission changes policy. presentation configures approval cards; set_presentation edits it without recompiling. Include fields needed to review the action. Module output is nested under result in a runtime permission/execution receipt.',
    route:
      "Routes export {name,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD',path:'/custom/...',auth:'mukai'|'session'|'handler'|'public',requiredEnv:[],timeoutMs?,handle(request,context),processJob?(payload,context)}. Paths are exact with no trailing slash. Mukai hosts the route; do not open a listener. handle returns {status,headers?,body?}. request includes headers, rawBody bytes, and parsed JSON body if applicable. For handler auth, verify provider signatures against request.rawBody before effects or enqueue. mukai uses a workspace route bearer token; session uses Mukai owner login (page visits sign in and return, signed-out APIs get 401); its cookies are verified and stripped. Public routes are explicitly unauthenticated. Routes do not take permissionMode.",
    job: "Jobs export {name,description,triggers:[{type:'interval',intervalMs:300000},{type:'workspace_start'}],requiredEnv:[],timeoutMs?,run(event,context),processJob?(payload,context)}. Use interval and/or workspace_start with no duplicates, OR a single {type:'once',runAt:'2026-10-30T18:00:00Z'} trigger with an ISO timestamp. For once, choose the actual desired time (a past/current time runs when available). It is consumed on the first attempt, including run_now: no replay after restart, failure, disable/enable or code-only update. Change runAt in an update to explicitly rearm. A manual run_now is always a deliberate new invocation. intervalMs: integer 1000–31536000000. workspace_start runs once per runtime start, after the VM worker is ready or a connected folder workspace initializes in the backend. Registration/enabling during an existing runtime waits for the next start; use run_now with id to test now. event includes trigger (interval, workspace_start, once, manual), scheduledAt (ISO), and runtimeId for scheduled runs. Same-job executions never overlap. Missed intervals coalesce to one run when available. Jobs require the backend and workspace runtime; they do not boot stopped VMs. Failed/interrupted runs are recorded without automatic retries; later intervals/new starts still run. Registration enables unattended execution: keep effects within user authorization. Jobs do not take permissionMode. list/inspect include health.lastRun, consecutiveFailures and lastError; ready does not imply successful execution. Verify history/effects. run_now consumes a pending once schedule; use a disposable job for one-shot testing.",
  };
  return `Manage workspace .ts/.js ${kind} modules. Write code first, then register/update with modulePath and optional exportName (default). register creates an ID; list/inspect returns IDs for later operations. Registrations are workspace-shared. ${contracts[kind]} Runtime helpers are in system context.`;
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
