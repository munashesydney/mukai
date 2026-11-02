import type { ChatFailure } from '../../../../shared/failures';
import type { Location } from '../workspace/types';

export function failureLocation(failure: ChatFailure): Location {
  const chat = failure.conversation;
  if (failure.pursuitId && failure.runId)
    return { section: 'pursuits', item: failure.pursuitId, runId: failure.runId };
  if (chat.kind === 'space') return { section: 'spaces', item: chat.id };
  if (chat.kind === 'bot')
    return { section: 'bots', item: 'bot-conversations', conversationId: chat.id };
  return { section: 'bots', item: chat.ownerBotId || chat.botIds[0], conversationId: chat.id };
}
