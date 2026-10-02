import type { ChatActivity } from '../../shared/ai';
import type { RuntimeOwner } from '../../shared/runtime';
export interface RuntimeToolContext {
  owner: RuntimeOwner;
  signal: AbortSignal;
  onActivity: (activity: ChatActivity) => void;
  budget: { remaining: number };
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
    context.signal.throwIfAborted();
    const visible =
      result && typeof result === 'object' && 'image' in result
        ? { ...result, image: undefined }
        : result;
    context.onActivity({
      ...activity,
      status: 'complete',
      summary: JSON.stringify(visible, null, 2).slice(0, 12000),
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
