import type { ChatActivity, ChatMessage } from '../../../../shared/ai';

function toolStatus(activity: ChatActivity): string {
  if (activity.action === 'wait_for_bots') return 'Waiting for bots';
  if (activity.tool === 'manage_bot') {
    if (activity.action === 'create') return 'Creating a bot';
    if (activity.action === 'send_message')
      return activity.delegation?.mode === 'wait'
        ? `Waiting for ${activity.delegation.botName}`
        : 'Delegating to a bot';
    if (activity.action === 'update') return 'Updating a bot';
    return 'Checking bots';
  }
  if (activity.tool === 'terminal' || activity.tool === 'process')
    return activity.action === 'run' ? 'Running a command' : 'Checking a command';
  const fileActions: Record<string, string> = {
    write_file: 'Writing a file',
    patch: 'Editing a file',
    read_file: 'Reading a file',
    search_files: 'Searching files',
    create_directory: 'Creating a folder',
  };
  if (fileActions[activity.action]) return fileActions[activity.action];
  if (activity.tool === 'browser') return 'Using the browser';
  if (activity.tool === 'computer_use') return 'Using the computer';
  if (activity.tool === 'media') return 'Inspecting media';
  return 'Calling tools';
}

/** Derive the current phase from live events, not earlier text in this response. */
export function responseStatus(message: ChatMessage): string {
  const active = message.activity?.filter((activity) => activity.status === 'running') || [];
  const tool = active.filter((activity) => activity.action !== 'wait_for_bots').at(-1);
  if (tool) return toolStatus(tool);
  if (active.some((activity) => activity.action === 'wait_for_bots')) return 'Waiting for bots';
  // An asynchronous bot reply does not change the parent's current generation phase.
  const latest = message.parts
    ?.filter(
      (part) =>
        part.type !== 'tool' ||
        !message.activity?.some(
          (activity) => activity.id === part.activityId && activity.action === 'receive_message',
        ),
    )
    .at(-1);
  if (latest?.type === 'compaction' && latest.state === 'compacting') return 'Compacting context';
  if (latest?.type === 'text') return 'Responding';
  if (latest?.type === 'reasoning') return 'Thinking';
  if (!latest && message.content) return 'Responding';
  return 'Thinking';
}
