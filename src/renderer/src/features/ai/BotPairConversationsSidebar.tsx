import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { Location } from '../workspace/types';
import { Avatar } from '../../components/ui/Avatar';
import { BotConversationStatus, ConversationStatus } from './ConversationStatus';
import { visibleConversations } from './conversationSidebar';

const INITIAL_CONVERSATION_COUNT = 3;

export function BotPairConversationsSidebar({
  bots,
  conversations,
  location,
  onSelect,
  loading,
  error,
  onRefresh,
  expandedGroup,
  onToggleGroup,
}: {
  bots: Bot[];
  conversations: Conversation[];
  location: Location;
  onSelect: (location: Location) => void;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  expandedGroup: string | null;
  onToggleGroup: (group: string) => void;
}) {
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const selectedRow = useRef<HTMLButtonElement>(null);
  const activeConversationId =
    location.section === 'bots' && location.item === 'bot-conversations'
      ? location.conversationId
      : undefined;
  const activeConversation = conversations.find((chat) => chat.id === activeConversationId);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [location, activeConversation?.id, expandedGroup]);
  const groups = new Map<string, { bots: Bot[]; conversations: Conversation[] }>();
  for (const conversation of conversations) {
    const ids = [...conversation.botIds].sort();
    const key = ids.join('/');
    const participants = ids
      .map((id) => bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => Boolean(bot));
    if (participants.length !== 2) continue;
    const group = groups.get(key) || { bots: participants, conversations: [] };
    group.conversations.push(conversation);
    groups.set(key, group);
  }
  return (
    <div className="bot-conversation-groups bot-pair-conversation-groups">
      {loading && <p className="ai-caption">Loading bot conversations…</p>}
      {error && (
        <p className="ai-alert" role="alert">
          {error}{' '}
          <button className="text-button" onClick={onRefresh}>
            Try again
          </button>
        </p>
      )}
      {!loading && !error && !groups.size && (
        <p className="ai-caption bot-pair-empty">
          Conversations appear here when bots message each other.
        </p>
      )}
      {[...groups].map(([key, group]) => {
        const open = expandedGroup === `pair:${key}`;
        const title = group.bots.map((bot) => bot.name).join('/');
        const visibleCount = visibleCounts[key] ?? INITIAL_CONVERSATION_COUNT;
        const visibleChats = visibleConversations(
          group.conversations,
          visibleCount,
          activeConversationId,
        );
        return (
          <section className="bot-conversation-group" key={key}>
            <div className="bot-conversation-heading">
              <button
                className="sidebar-row bot-conversation-parent"
                aria-label={title}
                aria-expanded={open}
                onClick={() => onToggleGroup(`pair:${key}`)}
              >
                <span className="bot-conversation-toggle bot-pair-toggle">
                  <span className="bot-pair-avatars">
                    {group.bots.map((bot) => (
                      <Avatar key={bot.id} person={bot.avatar} size="xs" />
                    ))}
                  </span>
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                <span>{title}</span>
                {!open && <BotConversationStatus conversations={group.conversations} />}
              </button>
            </div>
            {open && (
              <div className="bot-conversation-list">
                {visibleChats.map((chat) => (
                  <button
                    key={chat.id}
                    ref={activeConversationId === chat.id ? selectedRow : undefined}
                    className={`sidebar-row bot-conversation-row ${activeConversationId === chat.id ? 'is-selected' : ''}`}
                    aria-current={activeConversationId === chat.id ? 'page' : undefined}
                    title={chat.name}
                    onClick={() =>
                      onSelect({
                        section: 'bots',
                        item: 'bot-conversations',
                        conversationId: chat.id,
                      })
                    }
                  >
                    <span>{chat.name}</span>
                    <ConversationStatus
                      chatId={`space:${chat.id}`}
                      updatedAt={chat.updatedAt}
                      isWorking={chat.isWorking}
                    >
                      {new Date(chat.updatedAt).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </ConversationStatus>
                  </button>
                ))}
                {group.conversations.length > visibleChats.length && (
                  <button
                    className="bot-conversations-load-more"
                    onClick={() =>
                      setVisibleCounts((previous) => ({
                        ...previous,
                        [key]: visibleCount + INITIAL_CONVERSATION_COUNT,
                      }))
                    }
                  >
                    Load{' '}
                    {Math.min(
                      INITIAL_CONVERSATION_COUNT,
                      group.conversations.length - visibleChats.length,
                    )}{' '}
                    more
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
