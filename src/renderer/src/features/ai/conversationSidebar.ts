import type { Conversation } from '../../../../shared/conversations';
import type { Bot } from '../../../../shared/ai';
import type { Location } from '../workspace/types';

export function activeConversationGroup(location: Location, pairConversations: Conversation[]) {
  if (location.section !== 'bots' || location.item === 'hierarchy') return null;
  if (location.item === 'bot-conversations') {
    const pair = pairConversations.find((chat) => chat.id === location.conversationId);
    return pair ? `pair:${[...pair.botIds].sort().join('/')}` : 'pairs';
  }
  return `bot:${location.item}`;
}

export function botsByRecentInteraction(bots: Bot[], conversations: Conversation[]) {
  const latest = new Map<string, string>();
  for (const chat of conversations) {
    const id = botConversationGroup(chat);
    if (id && chat.updatedAt > (latest.get(id) ?? '')) latest.set(id, chat.updatedAt);
  }
  return [...bots].sort(
    (a, b) =>
      (latest.get(b.id) ?? '').localeCompare(latest.get(a.id) ?? '') ||
      Number(b.isMain) - Number(a.isMain),
  );
}

export function botConversationGroup(chat: Conversation) {
  return chat.kind === 'bot' ? chat.botIds[1] : chat.ownerBotId;
}

export function visibleConversations(
  conversations: Conversation[],
  count: number,
  activeConversationId?: string,
) {
  return conversations.filter(
    (chat, index) => index < count || chat.isWorking || chat.id === activeConversationId,
  );
}
