import type { RouteEnvironmentLease } from '../../shared/routeAccess';
import type { ChatActivity } from '../../shared/ai';
import { ACTIVITY_TRUNCATED, resultPreview } from '../services/toolResultPolicy';
import type { RuntimeOwner } from '../../shared/runtime';
import { serverUrls } from '../../shared/chatActivity';
import { terminalSnapshotSchema } from '../../shared/terminal';
export interface RuntimeToolContext {
  owner: RuntimeOwner;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
  budget: { remaining: number };
  resultBytes?: number;
  routeEnvironment?: (lifetimeMs: number, active?: () => Promise<boolean>) => RouteEnvironmentLease;
  isTerminalRunning?: (sessionId: string) => Promise<boolean>;
  resolveTerminalEnvironment?: (names: string[]) => Record<string, string>;
}
export async function executeRuntime<T>(
  context: RuntimeToolContext,
  callId: string,
  tool: string,
  action: string,
  path: string,
  execute: () => Promise<T> | T,
) {
  const activity: ChatActivity = { id: callId, tool, action, path, status: 'running', summary: '' };
  context.onActivity(activity);
  try {
    context.signal.throwIfAborted();
    if (--context.budget.remaining < 0)
      throw new Error('Runtime tool call limit reached. Summarize what completed.');
    const result = await execute();
    if (
      tool === 'terminal' &&
      result &&
      typeof result === 'object' &&
      'id' in result &&
      'status' in result
    ) {
      activity.processSessionId = String(result.id);
      const snapshot = terminalSnapshotSchema.safeParse(result);
      if (snapshot.success) activity.terminal = snapshot.data;
      if ('output' in result && typeof result.output === 'string')
        activity.serverUrls = serverUrls(result.output);
    }
    context.signal.throwIfAborted();
    const visible =
      result && typeof result === 'object' && ('image' in result || 'media' in result)
        ? Object.fromEntries(
            Object.entries(result).filter(([key]) => key !== 'image' && key !== 'media'),
          )
        : result;
    context.onActivity({
      ...activity,
      status: 'complete',
      summary: resultPreview(visible, 12000, ACTIVITY_TRUNCATED),
    });
    return { ok: true, result };
  } catch (error) {
    const summary = context.signal.aborted
      ? 'Operation interrupted.'
      : error instanceof Error
        ? error.message
        : 'Operation failed.';
    context.onActivity({
      ...activity,
      status: context.signal.aborted ? 'interrupted' : 'failed',
      summary,
    });
    return { ok: false, error: summary };
  }
}
