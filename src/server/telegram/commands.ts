export const telegramCommands = [
  { command: 'workspaces', description: 'Choose a Mukai workspace' },
  { command: 'new', description: 'Start a fresh conversation in this workspace' },
  { command: 'stop', description: 'Stop the current response and queued messages' },
  { command: 'approvals', description: 'Show waiting approvals and questions' },
  { command: 'updates', description: 'Show unread workspace updates' },
  { command: 'help', description: 'Show how to use Mukai' },
];

export function parseCommand(text: string, botUsername: string) {
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  return match[1].toLowerCase();
}

/** Plain text avoids partial Markdown parse failures and never splits a surrogate pair. */
export function splitTelegramText(text: string, limit = 4096) {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
