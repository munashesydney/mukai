import type { WorkspaceDeletionResult } from '../../../../shared/ai';

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
    ...(id === 'default' ? ['mukai.active-bot'] : []),
    ...result.botIds.map((botId) => `mukai.active-conversation.${botId}`),
    ...deletedChatKeys(result).map((chatId) => `mukai.draft.${chatId}`),
  ];
  for (const key of keys) storage.removeItem(key);
}
