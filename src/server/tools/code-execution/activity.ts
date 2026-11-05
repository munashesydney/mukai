import type { ChatActivity } from '../../../shared/ai';

/** Preserve execution evidence without feeding intermediate data back on later turns/retries. */
export function codeActivityForModel(activity: ChatActivity): ChatActivity {
  if (!activity.parentToolCallId) return activity;
  return {
    id: activity.id,
    parentToolCallId: activity.parentToolCallId,
    tool: activity.tool,
    action: activity.action,
    status: activity.status,
    path: '',
    summary:
      'Internal execute_code result omitted. Inspect saved activity before repeating actions.',
  };
}
