import type { WorkspaceDeletionResult } from '../../../../shared/ai';
import { activePairConversationKey } from './activeBotLocation';

export function deletedChatKeys(result: WorkspaceDeletionResult) {
  return [
    ...result.botIds,
    ...result.conversationIds.flatMap((id) => [`private:${id}`, `space:${id}`]),
  ];
}
export function clearDeletedWorkspaceStorage(
  storage: Pick<Storage, 'removeItem'>,
  id: string,
  result: WorkspaceDeletionResult,
) {
  const keys = [
    id === 'default' ? 'mukai.workspace.v1' : `mukai.workspace.v1.${id}`,
    `mukai.active-bot.${id}`,
    activePairConversationKey(id),
    ...(id === 'default' ? ['mukai.active-bot'] : []),
    ...result.botIds.map((botId) => `mukai.active-conversation.${botId}`),
    ...deletedChatKeys(result).map((chatId) => `mukai.draft.${chatId}`),
    ...result.conversationIds.map(
      (conversationId) => `mukai.joined-bot-chat.${id}.${conversationId}`,
    ),
  ];
  for (const key of keys) storage.removeItem(key);
}
