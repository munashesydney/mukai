import { ApiError } from '../../config';
import type { ToolContext } from '../types';
import type { FileOperationsInput } from './definition';

export async function executeFileOperations(
  input: FileOperationsInput,
  context: ToolContext,
  callId: string,
) {
  const activity = {
    id: callId,
    tool: 'file_operations',
    action: input.action,
    path: input.path || '.',
    status: 'running' as const,
    summary: '',
  };
  context.onActivity(activity);
  try {
    if (--context.callBudget.remaining < 0)
      throw new ApiError(
        400,
        'This run reached its file-operation safety budget. Summarize the results and remaining work.',
      );
    const result = await context.files.execute(input, context.signal);
    if ('changed' in result && result.changed) context.onFileChanged(result.path);
    context.onActivity({
      ...activity,
      path: result.path,
      status: 'complete',
      summary: result.summary,
    });
    return { ok: true, action: input.action, ...result };
  } catch (error) {
    const summary = context.signal.aborted
      ? 'File operation interrupted.'
      : error instanceof ApiError
        ? error.message
        : 'The file operation could not be completed. Check the path and folder permissions.';
    context.onActivity({
      ...activity,
      status: context.signal.aborted ? 'interrupted' : 'failed',
      summary,
    });
    return { ok: false, action: input.action, path: input.path || '.', summary };
  }
}
