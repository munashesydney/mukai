import type { Conversation } from '../../../../shared/conversations';

export function botConversationGroup(chat: Conversation) {
  return chat.kind === 'bot' ? chat.botIds[1] : chat.ownerBotId;
}

export function visibleConversations(conversations: Conversation[], count: number) {
  return conversations.filter((chat, index) => index < count || chat.isWorking);
}
