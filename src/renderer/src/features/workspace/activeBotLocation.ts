import type { Location } from './types';

export function activePairConversationKey(workspaceId: string) {
  return `mukai.active-pair-conversation.${workspaceId}`;
}

export function loadActiveBotLocation(
  workspaceId: string,
  storage?: Pick<Storage, 'getItem'>,
): Location {
  const fallback: Location = { section: 'bots', item: 'scout' };
  try {
    const saved = storage ?? localStorage;
    const item =
      saved.getItem(`mukai.active-bot.${workspaceId}`) ||
      (workspaceId === 'default' ? saved.getItem('mukai.active-bot') : null) ||
      'scout';
    const conversationId =
      item === 'bot-conversations'
        ? saved.getItem(activePairConversationKey(workspaceId)) ||
          saved.getItem('mukai.active-conversation.bot-conversations')
        : saved.getItem(`mukai.active-conversation.${item}`);
    if (item === 'hierarchy' || (item === 'bot-conversations' && !conversationId)) return fallback;
    return { section: 'bots', item, ...(conversationId ? { conversationId } : {}) };
  } catch {
    return fallback;
  }
}
