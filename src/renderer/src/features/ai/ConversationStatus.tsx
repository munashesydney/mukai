import type { ReactNode } from 'react';
import type { Conversation } from '../../../../shared/conversations';
import { useChatBusy, useConversationsBusy } from './chatStore';

import { WorkingIndicator } from '../../components/ui/WorkingIndicator';

export function BotConversationStatus({ conversations }: { conversations: Conversation[] }) {
  const busy = useConversationsBusy(
    conversations.map((chat) => `${chat.kind === 'bot' ? 'space' : 'private'}:${chat.id}`),
  );
  return busy || conversations.some((chat) => chat.isWorking) ? <WorkingIndicator /> : null;
}

export function ConversationStatus({
  chatId,
  updatedAt,
  isWorking = false,
  children,
}: {
  chatId: string;
  updatedAt: string;
  isWorking?: boolean;
  children: ReactNode;
}) {
  const busy = useChatBusy(chatId);
  return busy || isWorking ? (
    <WorkingIndicator />
  ) : (
    <time dateTime={updatedAt} title={new Date(updatedAt).toLocaleString()}>
      {children}
    </time>
  );
}
