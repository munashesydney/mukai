import type { ReactNode } from 'react';
import { useChatBusy } from './chatStore';

export function ConversationStatus({
  chatId,
  updatedAt,
  children,
}: {
  chatId: string;
  updatedAt: string;
  children: ReactNode;
}) {
  const busy = useChatBusy(chatId);
  return busy ? (
    <span className="bot-conversation-working" role="status" aria-label="AI is working">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  ) : (
    <time dateTime={updatedAt} title={new Date(updatedAt).toLocaleString()}>
      {children}
    </time>
  );
}
