import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { Location } from '../workspace/types';
import { Avatar } from '../../components/ui/Avatar';

export function BotPairConversationsSidebar({
  bots,
  conversations,
  location,
  onSelect,
  loading,
  error,
  onRefresh,
}: {
  bots: Bot[];
  conversations: Conversation[];
  location: Location;
  onSelect: (location: Location) => void;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
    <div className="bot-conversation-groups">
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
        <p className="sidebar-empty">Conversations appear here when bots message each other.</p>
      )}
      {[...groups].map(([key, group]) => {
        const open =
          expanded[key] ?? group.conversations.some((chat) => chat.id === location.conversationId);
        const title = group.bots.map((bot) => bot.name).join('/');
        return (
          <section className="bot-conversation-group" key={key}>
            <button
              className="sidebar-row bot-conversation-parent"
              aria-label={title}
              aria-expanded={open}
              onClick={() => setExpanded((previous) => ({ ...previous, [key]: !open }))}
            >
              <span className="bot-pair-avatars">
                {group.bots.map((bot) => (
                  <Avatar key={bot.id} person={bot.avatar} size="xs" />
                ))}
              </span>
              <span>{title}</span>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {open && (
              <div className="bot-conversation-list">
                {group.conversations.map((chat) => (
                  <button
                    key={chat.id}
                    className={`sidebar-row bot-conversation-row ${location.conversationId === chat.id ? 'is-selected' : ''}`}
                    aria-current={location.conversationId === chat.id ? 'page' : undefined}
                    title={chat.name}
                    onClick={() =>
                      onSelect({
                        section: 'spaces',
                        item: 'bot-conversations',
                        conversationId: chat.id,
                      })
                    }
                  >
                    <span>{chat.name}</span>
                    <time
                      dateTime={chat.updatedAt}
                      title={new Date(chat.updatedAt).toLocaleString()}
                    >
                      {new Date(chat.updatedAt).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
