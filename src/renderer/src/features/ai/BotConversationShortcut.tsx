import { useState, type ReactNode } from 'react';
import type { Conversation } from '../../../../shared/conversations';
import { Checkbox } from '../../components/ui/Checkbox';
import { PopupMenu } from '../../components/ui/PopupMenu';
import { useChatBusy } from './chatStore';

export const skipBotConversationConfirmationKey = 'mukai.skip-bot-conversation-confirmation';

export function BotConversationShortcut({
  chat,
  sender,
  receiver,
  skipConfirmation,
  onRemember,
  onSelect,
  children,
}: {
  chat: Conversation;
  sender: string;
  receiver: string;
  skipConfirmation: boolean;
  onRemember: () => void;
  onSelect: () => void;
  children: ReactNode;
}) {
  const busy = useChatBusy(`space:${chat.id}`);
  const [remember, setRemember] = useState(false);
  if (skipConfirmation) {
    return (
      <button className="sidebar-row bot-conversation-row" title={chat.name} onClick={onSelect}>
        {children}
      </button>
    );
  }
  return (
    <PopupMenu
      label={chat.name}
      buttonTitle={chat.name}
      title={`${sender} ${busy || chat.isWorking ? 'is' : 'was'} talking to ${receiver} here. Wanna go?`}
      role="dialog"
      placement="right"
      width={290}
      className="bot-conversation-shortcut"
      buttonClassName="sidebar-row bot-conversation-row"
      menuClassName="bot-conversation-confirmation"
      trigger={children}
    >
      {(close) => (
        <>
          <label className="bot-conversation-confirmation-remember">
            <Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Don’t show again
          </label>
          <div className="bot-conversation-confirmation-actions">
            <button
              className="button button--primary"
              onClick={() => {
                close();
                if (remember) onRemember();
                onSelect();
              }}
            >
              Yes
            </button>
            <button
              className="button"
              data-popup-autofocus
              onClick={() => {
                setRemember(false);
                close();
              }}
            >
              No
            </button>
          </div>
        </>
      )}
    </PopupMenu>
  );
}
