import type { ChatMessage } from '../../../../shared/ai';
import { TelegramLogo } from './TelegramLogo';

export function TelegramSourceBadge({
  message,
}: {
  message: Pick<ChatMessage, 'role' | 'source'>;
}) {
  if (message.role !== 'user' || message.source !== 'telegram') return null;
  return (
    <span
      className="message-telegram-source"
      role="img"
      aria-label="Sent from Telegram"
      title="Sent from Telegram"
    >
      <TelegramLogo size={13} />
    </span>
  );
}
