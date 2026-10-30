import type { ChatActivity } from '../../../../shared/ai';

const fileName = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '').split('/').at(-1);

export function mediaActivityKind(
  activity?: ChatActivity,
): 'image' | 'audio' | 'video' | undefined {
  if (activity?.tool === 'image' && activity.action === 'view') return 'image';
  if (activity?.tool !== 'media') return undefined;
  if (activity.action === 'view_image') return 'image';
  if (activity.action === 'listen_audio') return 'audio';
  if (activity.action === 'view_video') return 'video';
  return undefined;
}

function liveLabel(activity: ChatActivity): string {
  const name = fileName(activity.path);
  const files: Record<string, string> = {
    read_file: 'Reading',
    write_file: 'Writing',
    patch: 'Editing',
    create_directory: 'Creating folder',
    list: 'Listing',
    search_files: 'Searching',
    copy_attachment: 'Copying attachment to',
  };
  if (files[activity.action]) return `${files[activity.action]} ${name || 'files'}`;
  if (activity.action === 'wait_for_bots') return 'Waiting for bots';
  if (activity.action === 'receive_message')
    return `Reading reply from ${activity.path || 'a bot'}`;
  if (activity.tool === 'terminal' || activity.tool === 'process')
    return activity.action === 'run'
      ? `Running ${activity.terminal?.command || activity.path || 'a command'}`
      : 'Checking command output';
  if (activity.tool === 'manage_bot')
    return activity.action === 'send_message'
      ? `Delegating to ${activity.delegation?.botName || activity.path || 'a bot'}`
      : activity.action === 'create'
        ? 'Creating a bot'
        : 'Updating bots';
  if (activity.tool === 'ask')
    return activity.action === 'clarification' ? 'Waiting for your answer' : 'Waiting for approval';
  if (activity.tool === 'web_search') return 'Searching the web';
  if (activity.tool === 'browser') return 'Using the browser';
  if (activity.tool === 'computer_use') return 'Using the computer';
  if (activity.tool === 'system') return 'Checking saved variables';
  if (activity.tool === 'skills') return 'Reading skills';
  if (activity.tool === 'manage_pursuit') return 'Managing pursuits';
  if (activity.tool === 'media' || activity.tool === 'image') return 'Inspecting media';
  return `Using ${activity.tool.replaceAll('_', ' ')}`;
}

function completedLabel(activity: ChatActivity): string {
  if (activity.action === 'wait_for_bots') return 'Waited for bots';
  if (activity.action === 'receive_message') return 'Read bot replies';
  if (activity.tool === 'terminal' || activity.tool === 'process') return 'Ran commands';
  const files: Record<string, string> = {
    read_file: 'Read files',
    write_file: 'Edited files',
    patch: 'Edited files',
    create_directory: 'Created folders',
    list: 'Listed files',
    search_files: 'Searched files',
    copy_attachment: 'Copied attachments',
  };
  if (files[activity.action]) return files[activity.action];
  const tools: Record<string, string> = {
    browser: 'Used browser',
    computer_use: 'Used computer',
    web_search: 'Searched the web',
    media: 'Inspected media',
    image: 'Inspected images',
    manage_bot: 'Managed bots',
    manage_pursuit: 'Managed pursuits',
    system: 'Checked saved variables',
    skills: 'Read skills',
    ask: 'Reviewed requests',
  };
  return tools[activity.tool] || 'Used tools';
}

export function toolGroupLabel(activities: ChatActivity[], active: boolean): string {
  const media = mediaActivityKind(activities[0]);
  if (media && activities.every((activity) => mediaActivityKind(activity) === media)) {
    const count = active
      ? activities.length
      : activities.filter((item) => item.status === 'complete').length;
    const noun = media === 'audio' ? 'audio clip' : media;
    const verb =
      media === 'audio' ? (active ? 'Listening to' : 'Listened to') : active ? 'Viewing' : 'Viewed';
    if (!count)
      return media === 'audio'
        ? 'Audio listening'
        : `${media === 'image' ? 'Image' : 'Video'} viewing`;
    return `${verb} ${count} ${noun}${count === 1 ? '' : 's'}`;
  }
  if (active) {
    const latest =
      activities.filter((item) => item.status === 'running').at(-1) || activities.at(-1);
    return latest ? liveLabel(latest) : 'Calling tools';
  }
  const labels = [...new Set(activities.map(completedLabel))];
  const summary = labels
    .map((label, index) => (index ? label[0].toLowerCase() + label.slice(1) : label))
    .join(', ');
  return summary || 'Used tools';
}
